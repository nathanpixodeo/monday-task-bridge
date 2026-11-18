/**
 * bridge/uploads.ts – images an agent attaches to a monday update.
 *
 * The agent names local image files. The bridge reads and checks every one before anything is written, then keeps
 * their bytes in memory under random ids. The write that goes to the extension carries only those ids; the extension
 * fetches the bytes over HTTP (POST /v1/uploads/:id) and uploads them to monday, because an image does not fit in a
 * WebSocket message.
 *
 * Only PNG, JPEG, GIF and WebP files pass, judged by their first bytes and not by their names: posting an update
 * needs no approval in agent CLIs, so no other kind of file (a key, a .env) may go up with it.
 */

import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { StagedFile } from '../shared/types.js'

export const MAX_UPLOAD_FILES = 10
export const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024
export const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024

/** How long staged bytes stay when their write never settles; a settled write releases them at once. */
const STAGED_TTL_MS = 10 * 60_000

/** A file the agent named that cannot be attached; reported to MCP as INVALID_TARGET, before anything is written. */
export class UploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadError'
  }
}

interface Staged {
  bytes: Buffer
  mimeType: string
  expiresAt: number
}

const staged = new Map<string, Staged>()

const startsWith = (buf: Uint8Array, at: number, bytes: number[]) =>
  buf.length >= at + bytes.length && bytes.every((byte, index) => buf[at + index] === byte)

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))

/** The image type its first bytes show, or null when they are not those of a PNG, JPEG, GIF or WebP file. */
export function imageMimeOf(buf: Uint8Array): string | null {
  if (startsWith(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(buf, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(buf, 0, ascii('GIF87a')) || startsWith(buf, 0, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(buf, 0, ascii('RIFF')) && startsWith(buf, 8, ascii('WEBP'))) return 'image/webp'
  return null
}

function dropExpired(now: number): void {
  for (const [id, file] of staged) {
    if (file.expiresAt <= now) staged.delete(id)
  }
}

/**
 * Reads and checks the images at these absolute paths, then holds them for the extension. Throws an UploadError, and
 * holds nothing, when any one of them cannot be attached.
 */
export async function stageFiles(paths: string[]): Promise<StagedFile[]> {
  if (paths.length > MAX_UPLOAD_FILES) throw new UploadError(`Attach at most ${MAX_UPLOAD_FILES} files to one update`)
  const read: Array<{ name: string; mimeType: string; bytes: Buffer }> = []
  let total = 0
  for (const path of paths) {
    if (!isAbsolute(path)) throw new UploadError(`${path} is not an absolute path`)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new UploadError(`No file at ${path}`)
    // Checked before reading, so a huge file is never loaded
    if (info.size > MAX_UPLOAD_FILE_BYTES) throw new UploadError(`${path} is larger than ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB`)
    const bytes = await readFile(path).catch(() => null)
    if (bytes === null) throw new UploadError(`Could not read ${path}`)
    // The file may have changed since stat
    if (bytes.length > MAX_UPLOAD_FILE_BYTES) throw new UploadError(`${path} is larger than ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB`)
    total += bytes.length
    if (total > MAX_UPLOAD_TOTAL_BYTES) throw new UploadError(`The files are larger than ${MAX_UPLOAD_TOTAL_BYTES / 1024 / 1024} MB together`)
    const mimeType = imageMimeOf(bytes)
    if (mimeType === null) throw new UploadError(`${path} is not a PNG, JPEG, GIF or WebP image`)
    read.push({ name: basename(path).slice(-255), mimeType, bytes })
  }

  const now = Date.now()
  dropExpired(now)
  return read.map(({ name, mimeType, bytes }) => {
    const uploadId = randomBytes(16).toString('hex')
    staged.set(uploadId, { bytes, mimeType, expiresAt: now + STAGED_TTL_MS })
    return { uploadId, name, mimeType, size: bytes.length }
  })
}

/** The bytes held under this id, or null when they were released, expired, or never held. */
export function stagedFile(uploadId: string): { bytes: Buffer; mimeType: string } | null {
  const file = staged.get(uploadId)
  if (!file) return null
  if (file.expiresAt <= Date.now()) {
    staged.delete(uploadId)
    return null
  }
  return { bytes: file.bytes, mimeType: file.mimeType }
}

/** Lets go of the bytes once their write has settled. */
export function releaseStaged(files: readonly StagedFile[]): void {
  for (const file of files) staged.delete(file.uploadId)
}

/** How many files are held now; for tests. */
export function stagedCount(): number {
  dropExpired(Date.now())
  return staged.size
}
