/**
 * bridge/store.ts – persistent file-based store.
 *
 * Data directory: %LOCALAPPDATA%/monday-task-bridge  (Windows)
 *                 $XDG_DATA_HOME/monday-task-bridge  (Linux)
 *                 ~/Library/Application Support/monday-task-bridge (macOS)
 *
 * Layout:
 *   admin-token            – plain-text admin token (mode 0600)
 *   bridge-token           – plain-text bridge token (mode 0600)
 *   paired-origin          – plain-text bound chrome-extension origin (mode 0600)
 *   snapshots/             – one JSON per snapshot, keyed by sha256(requestId)
 *   images/                – raw image bytes, keyed by sha256(upload id)
 */

import { randomBytes, createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir, unlink, stat, rename, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { platform, env } from 'node:process'
import type { TaskSnapshot, ImageUpload } from '../shared/types.js'

// ---------------------------------------------------------------------------
// Data-dir resolution
// ---------------------------------------------------------------------------

export function resolveDataDir(): string {
  if (env.MONDAY_BRIDGE_DATA_DIR) return resolve(env.MONDAY_BRIDGE_DATA_DIR)
  const name = 'monday-task-bridge'
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA ?? join(env.USERPROFILE ?? 'C:\\Users\\Default', 'AppData', 'Local'), name)
  }
  if (platform === 'darwin') {
    return join(env.HOME ?? '/tmp', 'Library', 'Application Support', name)
  }
  return join(env.XDG_DATA_HOME ?? join(env.HOME ?? '/tmp', '.local', 'share'), name)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isValidStoreId(id: unknown): id is string {
  if (typeof id !== 'string') return false
  const trimmed = id.trim()
  if (!trimmed || trimmed.length > 256) return false
  if (
    trimmed.includes('..') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('\0')
  ) {
    return false
  }
  return true
}

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

async function atomicWrite(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const tmp = path + '.tmp.' + randomBytes(4).toString('hex')
  await writeFile(tmp, data, { mode })
  try {
    await chmod(tmp, mode)
  } catch {
    // Windows or filesystems without POSIX chmod support
  }
  await rename(tmp, path)
  try {
    await chmod(path, mode)
  } catch {
    // Ignore where unsupported
  }
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_SNAPSHOTS = 200
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface StoredSnapshot {
  requestId: string
  snapshot: TaskSnapshot
  imageIds: string[]
  storedAt: string
}

export class Store {
  readonly dataDir: string
  private _snapshotsDir: string
  private _imagesDir: string

  private _adminTokenLock: Promise<string> | null = null
  private _bridgeTokenLock: Promise<string> | null = null

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? resolveDataDir()
    this._snapshotsDir = join(this.dataDir, 'snapshots')
    this._imagesDir = join(this.dataDir, 'images')
  }

  async init(): Promise<void> {
    await ensureDir(this.dataDir)
    await ensureDir(this._snapshotsDir)
    await ensureDir(this._imagesDir)
  }

  // -- Admin token ----------------------------------------------------------

  async getAdminToken(): Promise<string> {
    if (this._adminTokenLock) return this._adminTokenLock

    this._adminTokenLock = (async () => {
      try {
        const tokenPath = join(this.dataDir, 'admin-token')
        const existing = await safeRead(tokenPath)
        if (existing?.trim()) {
          try {
            await chmod(tokenPath, 0o600)
          } catch {}
          return existing.trim()
        }

        const token = generateToken()
        try {
          await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 })
          try {
            await chmod(tokenPath, 0o600)
          } catch {}
          return token
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
            const readAgain = await safeRead(tokenPath)
            if (readAgain?.trim()) return readAgain.trim()
          }
          throw err
        }
      } finally {
        this._adminTokenLock = null
      }
    })()

    return this._adminTokenLock
  }

  // -- Bridge token (extension auth) ----------------------------------------

  async getBridgeToken(): Promise<string | null> {
    const tokenPath = join(this.dataDir, 'bridge-token')
    const t = await safeRead(tokenPath)
    if (t?.trim()) {
      try {
        await chmod(tokenPath, 0o600)
      } catch {}
      return t.trim()
    }
    return null
  }

  async setBridgeToken(token: string): Promise<void> {
    await atomicWrite(join(this.dataDir, 'bridge-token'), token, 0o600)
  }

  async ensureBridgeToken(): Promise<string> {
    if (this._bridgeTokenLock) return this._bridgeTokenLock

    this._bridgeTokenLock = (async () => {
      try {
        const existing = await this.getBridgeToken()
        if (existing) return existing

        const token = generateToken()
        const tokenPath = join(this.dataDir, 'bridge-token')
        try {
          await writeFile(tokenPath, token, { flag: 'wx', mode: 0o600 })
          try {
            await chmod(tokenPath, 0o600)
          } catch {}
          return token
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
            const readAgain = await this.getBridgeToken()
            if (readAgain) return readAgain
          }
          throw err
        }
      } finally {
        this._bridgeTokenLock = null
      }
    })()

    return this._bridgeTokenLock
  }

  // -- Paired extension origin ----------------------------------------------

  async getPairedOrigin(): Promise<string | null> {
    const originPath = join(this.dataDir, 'paired-origin')
    const o = await safeRead(originPath)
    return o?.trim() || null
  }

  async setPairedOrigin(origin: string): Promise<void> {
    await atomicWrite(join(this.dataDir, 'paired-origin'), origin, 0o600)
  }

  // -- Snapshots ------------------------------------------------------------

  private _snapshotPath(requestId: string): string {
    const safe = createHash('sha256').update(requestId).digest('hex')
    return join(this._snapshotsDir, `${safe}.json`)
  }

  private _imagePath(imageId: string): string {
    const safe = createHash('sha256').update(imageId).digest('hex')
    return join(this._imagesDir, safe)
  }

  async saveSnapshot(requestId: string, snapshot: TaskSnapshot, images: ImageUpload[]): Promise<void> {
    // Validate request ID
    if (!isValidStoreId(requestId)) {
      throw new Error(`Invalid requestId: ${requestId}`)
    }

    // Validate image IDs and attachment IDs against traversal
    for (const img of images) {
      if (!isValidStoreId(img.id)) {
        throw new Error(`Invalid image ID: ${img.id}`)
      }
    }
    for (const att of snapshot.attachments) {
      if (!isValidStoreId(att.id)) {
        throw new Error(`Invalid attachment ID: ${att.id}`)
      }
    }

    // Ensure every ready attachment has matching uploaded image
    const imageIdsSet = new Set(images.map(img => img.id))
    for (const att of snapshot.attachments) {
      if (att.status === 'ready' && !imageIdsSet.has(att.id)) {
        throw new Error(`Ready attachment '${att.id}' has no matching uploaded image`)
      }
    }

    // Save images using hashed filenames
    const imageIds: string[] = []
    for (const img of images) {
      const buf = Buffer.from(img.dataBase64, 'base64')
      const imgPath = this._imagePath(img.id)
      await atomicWrite(imgPath, buf, 0o600)
      imageIds.push(img.id)
    }

    const entry: StoredSnapshot = {
      requestId,
      snapshot,
      imageIds,
      storedAt: new Date().toISOString(),
    }
    await atomicWrite(this._snapshotPath(requestId), JSON.stringify(entry), 0o600)

    // Enforce retention
    await this._enforceRetention()
  }

  async getSnapshot(requestId: string): Promise<StoredSnapshot | null> {
    if (!isValidStoreId(requestId)) return null
    const raw = await safeRead(this._snapshotPath(requestId))
    if (!raw) return null
    return JSON.parse(raw) as StoredSnapshot
  }

  async getLatestSnapshot(): Promise<StoredSnapshot | null> {
    const entries = await this._allSnapshots()
    if (!entries.length) return null
    entries.sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime())
    return entries[0]
  }

  async listSnapshots(): Promise<StoredSnapshot[]> {
    const entries = await this._allSnapshots()
    entries.sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime())
    return entries
  }

  async getImageBytes(imageId: string): Promise<Buffer | null> {
    if (!isValidStoreId(imageId)) return null
    try {
      return await readFile(this._imagePath(imageId))
    } catch {
      return null
    }
  }

  async findSnapshotByBoardItem(boardId?: string, itemId?: string): Promise<StoredSnapshot | null> {
    const all = await this._allSnapshots()
    // newest first
    all.sort((a, b) => new Date(b.storedAt).getTime() - new Date(a.storedAt).getTime())
    return all.find(s => (!boardId || s.snapshot.boardId === boardId) &&
      (!itemId || s.snapshot.itemId === itemId)) ?? null
  }

  // -- Internal -------------------------------------------------------------

  private async _allSnapshots(): Promise<StoredSnapshot[]> {
    let files: string[]
    try {
      files = await readdir(this._snapshotsDir)
    } catch {
      return []
    }
    const results: StoredSnapshot[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const raw = await safeRead(join(this._snapshotsDir, f))
      if (!raw) continue
      try {
        results.push(JSON.parse(raw) as StoredSnapshot)
      } catch {
        /* skip corrupt */
      }
    }
    return results
  }

  private async _enforceRetention(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this._snapshotsDir)
    } catch {
      return
    }
    files = files.filter(f => f.endsWith('.json'))

    // Gather snapshots with modification times
    const entries: { name: string; mtime: number }[] = []
    for (const f of files) {
      try {
        const s = await stat(join(this._snapshotsDir, f))
        entries.push({ name: f, mtime: s.mtimeMs })
      } catch {
        /* skip */
      }
    }
    entries.sort((a, b) => b.mtime - a.mtime) // newest first

    const now = Date.now()
    const doomedFiles: string[] = []
    const retainedFiles: string[] = []

    for (let i = 0; i < entries.length; i++) {
      const tooOld = now - entries[i].mtime > MAX_SNAPSHOT_AGE_MS
      const overLimit = i >= MAX_SNAPSHOTS
      if (tooOld || overLimit) {
        doomedFiles.push(entries[i].name)
      } else {
        retainedFiles.push(entries[i].name)
      }
    }

    if (!doomedFiles.length) return

    // Collect all image IDs referenced by snapshots that are still being retained
    const activeImageIds = new Set<string>()
    for (const fileName of retainedFiles) {
      try {
        const raw = await safeRead(join(this._snapshotsDir, fileName))
        if (raw) {
          const snap = JSON.parse(raw) as StoredSnapshot
          if (Array.isArray(snap.imageIds)) {
            for (const imgId of snap.imageIds) {
              activeImageIds.add(imgId)
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    // Safely remove doomed snapshots and unreferenced images
    const deletedImageFiles = new Set<string>()
    for (const fileName of doomedFiles) {
      try {
        const raw = await safeRead(join(this._snapshotsDir, fileName))
        if (raw) {
          const snap = JSON.parse(raw) as StoredSnapshot
          if (Array.isArray(snap.imageIds)) {
            for (const imgId of snap.imageIds) {
              // Retention must not delete images still referenced by newer snapshots
              if (!activeImageIds.has(imgId) && !deletedImageFiles.has(imgId)) {
                deletedImageFiles.add(imgId)
                try {
                  await unlink(this._imagePath(imgId))
                } catch {
                  /* ok */
                }
              }
            }
          }
        }
      } catch {
        /* ok */
      }

      try {
        await unlink(join(this._snapshotsDir, fileName))
      } catch {
        /* ok */
      }
    }
  }
}
