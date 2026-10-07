/**
 * bridge/server.ts – HTTP + WebSocket server on 127.0.0.1:3457.
 *
 * Strict loopback Host, per-route Origin checking after pairing,
 * never wildcard CORS.
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { Store } from './store.js'
import { PairingManager, safeCompare } from './pairing.js'
import {
  CapturePayloadSchema,
  PairRequestBodySchema,
  PairApproveBodySchema,
  validateCaptureSize,
} from './validate.js'
import type { CapturePayload, ExtensionToBridgeMessage, BridgeToExtensionMessage } from '../shared/types.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1'
const PORT = Number(process.env.MONDAY_BRIDGE_PORT ?? 3457)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('MONDAY_BRIDGE_PORT must be an integer from 1 to 65535')
}
const CAPTURE_TIMEOUT_MS = 180_000

// Strict loopback Host headers (port 3457 enforced)
const STRICT_LOOPBACK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const store = new Store()
export const pairing = new PairingManager()

interface LiveSocket {
  ws: WebSocket
  token: string
  authenticated: boolean
  origin?: string
}

/** Map of active extension WebSocket connections keyed by connection ID. */
const liveSockets = new Map<string, LiveSocket>()

interface PendingCapture {
  requestId: string
  targetConnId: string
  resolve: (payload: CapturePayload) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingCaptures = new Map<string, PendingCapture>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

export class PayloadTooLargeError extends Error {
  constructor(message = 'Payload too large') {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * Read request body with maximum byte limit.
 * If exceeded, drains remaining stream and rejects with PayloadTooLargeError
 * so that an HTTP 413 response can be delivered cleanly without socket destruction.
 */
export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = false

    req.on('data', (chunk: Buffer) => {
      if (exceeded) return
      size += chunk.length
      if (size > maxBytes) {
        exceeded = true
        req.resume() // drain and discard remaining stream
        reject(new PayloadTooLargeError(`Payload exceeds limit of ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (!exceeded) {
        resolve(Buffer.concat(chunks).toString('utf-8'))
      }
    })

    req.on('error', (err) => {
      if (!exceeded) {
        reject(err)
      }
    })
  })
}

function enforceLoopbackHost(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? ''
  return STRICT_LOOPBACK_HOSTS.has(host)
}

export function isWebOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  const lower = origin.toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://') || lower === 'null'
}

export function isExtensionOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  return /^chrome-extension:\/\/[a-z0-9]{32}$/i.test(origin)
}

function setCorsHeaders(res: http.ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pairing-Secret, X-Bridge-Admin-Token')
  res.setHeader('Access-Control-Max-Age', '600')
}

/** Send a typed message over WebSocket. */
function wsSend(ws: WebSocket, msg: BridgeToExtensionMessage): void {
  ws.send(JSON.stringify(msg))
}

function cleanupSocket(connId: string): void {
  liveSockets.delete(connId)
  // Clean up any pending captures routed through this socket
  for (const [reqId, pending] of pendingCaptures.entries()) {
    if (pending.targetConnId === connId) {
      clearTimeout(pending.timer)
      pendingCaptures.delete(reqId)
      pending.reject(new Error('BROWSER_OFFLINE'))
    }
  }
}

// ---------------------------------------------------------------------------
// Capture request/resolution
// ---------------------------------------------------------------------------

/**
 * Request a capture from the connected extension.
 * Returns a promise that resolves when the extension posts the snapshot.
 */
export function requestCapture(): Promise<CapturePayload> {
  // Find an authenticated socket
  let targetConnId: string | undefined
  let target: LiveSocket | undefined
  for (const [connId, ls] of Array.from(liveSockets.entries()).reverse()) {
    if (ls.authenticated && ls.ws.readyState === WebSocket.OPEN) {
      targetConnId = connId
      target = ls
      break
    }
  }
  if (!target || !targetConnId) {
    return Promise.reject(new Error('BROWSER_OFFLINE'))
  }

  const requestId = randomBytes(8).toString('hex')

  return new Promise<CapturePayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCaptures.delete(requestId)
      reject(new Error('CAPTURE_TIMEOUT'))
    }, CAPTURE_TIMEOUT_MS)

    pendingCaptures.set(requestId, {
      requestId,
      targetConnId: targetConnId!,
      resolve,
      reject,
      timer,
    })
    wsSend(target!.ws, { type: 'capture', requestId })
  })
}

/**
 * Resolve a pending capture with the provided payload.
 */
export function resolveCapture(requestId: string, payload: CapturePayload): boolean {
  const pending = pendingCaptures.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingCaptures.delete(requestId)
  pending.resolve(payload)
  return true
}

/**
 * Reject a pending capture with an error.
 */
export function rejectCapture(requestId: string, errorMsg: string): boolean {
  const pending = pendingCaptures.get(requestId)
  if (!pending) return false
  clearTimeout(pending.timer)
  pendingCaptures.delete(requestId)
  pending.reject(new Error(errorMsg))
  return true
}

export function resetCaptures(): void {
  for (const pending of pendingCaptures.values()) {
    clearTimeout(pending.timer)
    pending.reject(new Error('BROWSER_OFFLINE'))
  }
  pendingCaptures.clear()
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const bridgeToken = await store.getBridgeToken()
  let extensionConnected = false
  for (const ls of liveSockets.values()) {
    if (ls.authenticated && ls.ws.readyState === WebSocket.OPEN) {
      extensionConnected = true
      break
    }
  }
  json(res, 200, {
    status: 'ok',
    paired: bridgeToken !== null,
    extensionConnected,
    uptime: process.uptime(),
  })
}

async function handlePairRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string
): Promise<void> {
  const body = await readBody(req, 4096)
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }
  const parsed = PairRequestBodySchema.safeParse(parsedJson)
  if (!parsed.success) {
    json(res, 400, { error: 'Invalid body', details: parsed.error.issues })
    return
  }
  try {
    const result = pairing.createRequest(parsed.data.secret, origin)
    json(res, 200, result)
  } catch {
    json(res, 429, { error: 'Too many pending pairing requests; try again shortly' })
  }
}

async function handlePairPoll(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pairId: string,
  origin: string
): Promise<void> {
  const secret = req.headers['x-pairing-secret'] as string | undefined
  if (!secret) {
    json(res, 401, { error: 'Missing X-Pairing-Secret header' })
    return
  }
  const result = pairing.poll(pairId, secret, origin)
  if (!result) {
    json(res, 404, { error: 'Pairing not found or expired' })
    return
  }
  json(res, 200, result)
}

async function handlePairApprove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const adminToken = req.headers['x-bridge-admin-token'] as string | undefined
  const expectedAdmin = await store.getAdminToken()
  if (!adminToken || !safeCompare(adminToken, expectedAdmin)) {
    json(res, 403, { error: 'Invalid admin token' })
    return
  }

  const body = await readBody(req, 4096)
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(body)
  } catch {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }
  const parsed = PairApproveBodySchema.safeParse(parsedJson)
  if (!parsed.success) {
    json(res, 400, { error: 'Invalid body', details: parsed.error.issues })
    return
  }

  // Ensure a bridge token exists
  const bridgeToken = await store.ensureBridgeToken()

  const result = pairing.approveByCode(parsed.data.code, bridgeToken)
  if (!result) {
    json(res, 404, { error: 'Pairing code not found or expired' })
    return
  }

  // Bind paired origin to later requests
  if (result.origin) {
    await store.setPairedOrigin(result.origin)
  }

  json(res, 200, { pairId: result.pairId, approved: true })
}

async function handleSnapshots(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  origin: string
): Promise<void> {
  // Authenticate with Bearer token using timing-safe comparison
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    json(res, 401, { error: 'Missing Bearer token' })
    return
  }
  const token = auth.slice(7)
  const bridgeToken = await store.getBridgeToken()
  if (!bridgeToken || !safeCompare(token, bridgeToken)) {
    json(res, 403, { error: 'Invalid bridge token' })
    return
  }

  // Bind or verify paired extension origin
  const pairedOrigin = await store.getPairedOrigin()
  if (pairedOrigin && !safeCompare(origin, pairedOrigin)) {
    json(res, 403, { error: 'Forbidden: origin does not match paired extension' })
    return
  } else if (!pairedOrigin) {
    await store.setPairedOrigin(origin)
  }

  const rawBody = await readBody(req, 100 * 1024 * 1024)
  if (!validateCaptureSize(rawBody)) {
    json(res, 413, { error: 'Payload too large' })
    return
  }

  let bodyObj: unknown
  try {
    bodyObj = JSON.parse(rawBody)
  } catch {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }

  const parsed = CapturePayloadSchema.safeParse(bodyObj)
  if (!parsed.success) {
    if (bodyObj && typeof bodyObj === 'object' && 'requestId' in bodyObj &&
        typeof bodyObj.requestId === 'string') {
      rejectCapture(bodyObj.requestId, 'Invalid capture payload')
    }
    json(res, 400, { error: 'Invalid payload', details: parsed.error.issues })
    return
  }

  const payload = parsed.data as CapturePayload

  // Ensure unsupported image or incomplete payload never gets silent complete true
  if (payload.snapshot.complete) {
    const allReady = payload.snapshot.attachments.every(a => a.status === 'ready' && !a.error)
    const uploadedIds = new Set(payload.images.map(img => img.id))
    const allPresent = payload.snapshot.attachments.every(a => uploadedIds.has(a.id))
    if (!allReady || !allPresent) {
      payload.snapshot.complete = false
      if (!payload.snapshot.warnings.includes('Incomplete payload: attachments unavailable or missing')) {
        payload.snapshot.warnings.push('Incomplete payload: attachments unavailable or missing')
      }
    }
  }

  const requestId = payload.requestId ?? randomBytes(8).toString('hex')

  // Save atomically with ID hashing and traversal validation
  try {
    await store.saveSnapshot(requestId, payload.snapshot, payload.images)
  } catch (err) {
    if (payload.requestId) rejectCapture(payload.requestId, 'Could not store capture')
    throw err
  }

  // Resolve any pending capture
  if (payload.requestId) {
    resolveCapture(payload.requestId, payload)
  }

  json(res, 200, { requestId, stored: true })
}

async function handleReadOpenTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const adminToken = req.headers['x-bridge-admin-token'] as string | undefined
  const expectedAdmin = await store.getAdminToken()
  if (!adminToken || !safeCompare(adminToken, expectedAdmin)) {
    json(res, 403, { error: 'Invalid admin token' })
    return
  }

  try {
    const payload = await requestCapture()
    json(res, 200, {
      snapshot: payload.snapshot,
      imageCount: payload.images.length,
      capturedAt: payload.snapshot.capturedAt,
      complete: payload.snapshot.complete,
      warnings: payload.snapshot.warnings,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    json(res, 502, { error: msg })
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // 1. Strict Host header check BEFORE URL parsing (127.0.0.1:3457 / localhost:3457)
  if (!enforceLoopbackHost(req)) {
    json(res, 403, { error: 'Forbidden: non-loopback Host' })
    return
  }

  // 2. Parse URL with trusted loopback base
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const method = req.method ?? 'GET'
  const pathname = url.pathname
  const isPairingPath = pathname === '/v1/pair/request' || /^\/v1\/pair\/[a-f0-9]+$/.test(pathname)

  // 3. Reject web origins immediately across all routes
  const origin = req.headers.origin as string | undefined
  if (isWebOrigin(origin)) {
    json(res, 403, { error: 'Forbidden: web origins are rejected' })
    return
  }

  // 4. Handle CORS preflight – strict chrome-extension origin only
  if (method === 'OPTIONS') {
    if (origin && isExtensionOrigin(origin)) {
      const pairedOrigin = await store.getPairedOrigin()
      if (isPairingPath || !pairedOrigin || safeCompare(origin, pairedOrigin)) {
        setCorsHeaders(res, origin)
        res.writeHead(204)
        res.end()
        return
      }
    }
    res.writeHead(403)
    res.end()
    return
  }

  // 5. Echo CORS headers for valid extension origin
  if (origin && isExtensionOrigin(origin)) {
    const pairedOrigin = await store.getPairedOrigin()
    if (isPairingPath || !pairedOrigin || safeCompare(origin, pairedOrigin)) {
      setCorsHeaders(res, origin)
    }
  }

  try {
    // GET /health – callable by CLI/MCP (no Origin) or extension
    if (method === 'GET' && pathname === '/health') {
      await handleHealth(req, res)
      return
    }

    // POST /v1/pair/request – extension route (requires chrome-extension Origin)
    if (method === 'POST' && pathname === '/v1/pair/request') {
      if (!origin || !isExtensionOrigin(origin)) {
        json(res, 403, { error: 'Forbidden: requires chrome-extension Origin' })
        return
      }
      await handlePairRequest(req, res, origin)
      return
    }

    // GET /v1/pair/:pairId – extension route (requires chrome-extension Origin)
    const pairMatch = pathname.match(/^\/v1\/pair\/([a-f0-9]+)$/)
    if (method === 'GET' && pairMatch) {
      if (!origin || !isExtensionOrigin(origin)) {
        json(res, 403, { error: 'Forbidden: requires chrome-extension Origin' })
        return
      }
      await handlePairPoll(req, res, pairMatch[1], origin)
      return
    }

    // POST /v1/pair/approve – CLI admin route (allowed without Origin)
    if (method === 'POST' && pathname === '/v1/pair/approve') {
      await handlePairApprove(req, res)
      return
    }

    // POST /v1/snapshots – extension route (requires chrome-extension Origin)
    if (method === 'POST' && pathname === '/v1/snapshots') {
      if (!origin || !isExtensionOrigin(origin)) {
        json(res, 403, { error: 'Forbidden: requires chrome-extension Origin' })
        return
      }
      await handleSnapshots(req, res, origin)
      return
    }

    // POST /v1/read-open-task – MCP admin route (allowed without Origin)
    if (method === 'POST' && pathname === '/v1/read-open-task') {
      await handleReadOpenTask(req, res)
      return
    }

    json(res, 404, { error: 'Not found' })
  } catch (err: unknown) {
    if (err instanceof PayloadTooLargeError) {
      if (!res.headersSent) {
        json(res, 413, { error: 'Payload too large' })
      }
      return
    }
    const msg = err instanceof Error ? err.message : 'Internal error'
    if (!res.headersSent) {
      json(res, 500, { error: msg })
    }
  }
}

// ---------------------------------------------------------------------------
// WebSocket /v1/live
// ---------------------------------------------------------------------------

function setupWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024, // Bound control message size (64 KB)
  })

  server.on('upgrade', async (req, socket, head) => {
    try {
    // 1. Enforce Host before URL parsing
    if (!enforceLoopbackHost(req)) {
      socket.destroy()
      return
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    if (url.pathname !== '/v1/live') {
      socket.destroy()
      return
    }

    // 2. Reject web origins and enforce chrome-extension Origin
    const origin = req.headers.origin as string | undefined
    if (!origin || isWebOrigin(origin) || !isExtensionOrigin(origin)) {
      socket.destroy()
      return
    }

    // 3. Check bound paired origin if exists
    const pairedOrigin = await store.getPairedOrigin()
    if (pairedOrigin && !safeCompare(origin, pairedOrigin)) {
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
    } catch {
      socket.destroy()
    }
  })

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const connId = randomBytes(8).toString('hex')
    const origin = req.headers.origin as string | undefined
    const liveSocket: LiveSocket = { ws, token: '', authenticated: false, origin }

    // Extension must send hello with token as first message
    const authTimeout = setTimeout(() => {
      if (!liveSocket.authenticated) {
        ws.close(4001, 'Authentication timeout')
      }
    }, 10_000)

    ws.on('message', async (data: Buffer) => {
      try {
      // Bound control message size
      if (data.length > 64 * 1024) {
        ws.close(1009, 'Message too large')
        return
      }

      let msg: ExtensionToBridgeMessage
      try {
        msg = JSON.parse(data.toString('utf-8'))
      } catch {
        ws.close(4002, 'Invalid message')
        return
      }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        ws.close(4002, 'Invalid message')
        return
      }

      if (msg.type === 'hello') {
        clearTimeout(authTimeout)
        const bridgeToken = await store.getBridgeToken()
        if (!bridgeToken || !safeCompare(msg.token, bridgeToken)) {
          ws.close(4003, 'Invalid token')
          return
        }

        // Bind paired origin if not yet saved
        if (origin && isExtensionOrigin(origin)) {
          const paired = await store.getPairedOrigin()
          if (!paired) {
            await store.setPairedOrigin(origin)
          }
        }

        liveSocket.token = msg.token
        liveSocket.authenticated = true
        for (const [oldId, old] of liveSockets) {
          if (old.ws !== ws && old.authenticated) {
            old.ws.close(1000, 'Replaced by new connection')
            cleanupSocket(oldId)
          }
        }
        liveSockets.set(connId, liveSocket)
        wsSend(ws, { type: 'hello-ack' })
        return
      }

      if (msg.type === 'heartbeat') {
        if (!liveSocket.authenticated) {
          ws.close(4003, 'Not authenticated')
          return
        }
        // Authenticated heartbeat: ignore (no-op)
        return
      }

      if (msg.type === 'capture-result') {
        if (!liveSocket.authenticated) {
          ws.close(4003, 'Not authenticated')
          return
        }
        if (msg.error) {
          rejectCapture(msg.requestId, msg.error)
        }
        return
      }
      } catch {
        ws.close(1011, 'Bridge message error')
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimeout)
      cleanupSocket(connId)
    })

    ws.on('error', () => {
      clearTimeout(authTimeout)
      cleanupSocket(connId)
    })
  })
}

// ---------------------------------------------------------------------------
// Boot & Shutdown
// ---------------------------------------------------------------------------

export async function startServer(): Promise<http.Server> {
  await store.init()
  // Ensure admin token exists without logging secrets
  await store.getAdminToken()
  process.stderr.write('[bridge] Admin token initialized\n')
  process.stderr.write(`[bridge] Data dir: ${store.dataDir}\n`)

  const server = http.createServer((req, res) => {
    void route(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'Internal error' })
      else res.end()
    })
  })
  setupWebSocket(server)

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, () => {
      server.off('error', reject)
      process.stderr.write(`[bridge] Listening on http://${HOST}:${PORT}\n`)
      resolve(server)
    })
  })
}

export async function closeServer(server?: http.Server): Promise<void> {
  resetCaptures()
  for (const ls of liveSockets.values()) {
    try {
      ls.ws.close()
    } catch {}
  }
  liveSockets.clear()

  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}

// ---------------------------------------------------------------------------
// Main entry point (when run directly)
// ---------------------------------------------------------------------------

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'))

if (isMain) {
  startServer().catch((err) => {
    process.stderr.write(`[bridge] Fatal: ${err}\n`)
    process.exit(1)
  })
}
