import { getConfig, setConfig } from './helpers/storage'
import type {
  TaskSnapshot,
  TaskAttachment,
  ImageUpload,
  CapturePayload,
  ExtensionToBridgeMessage,
  BridgeToExtensionMessage
} from '../shared/types'

let ws: WebSocket | null = null
let authenticated = false
let heartbeatInterval: ReturnType<typeof setInterval> | null = null

// ─── Alarms: reconnect + heartbeat ───────────────────────────────────

chrome.alarms.create('ws-reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ws-reconnect') {
    connectWs()
  }
  if (alarm.name === 'pairing-timeout') {
    handlePairingTimeout()
  }
})

async function handlePairingTimeout() {
  const config = await getConfig()
  if (config.status === 'pairing') {
    await setConfig({
      status: 'error',
      error: 'Pairing timed out (2 min)',
      pairId: null,
      pairingSecret: null,
      pairCode: null,
      expiresAt: null
    })
  }
}

// ─── WebSocket connection ────────────────────────────────────────────

async function connectWs() {
  const config = await getConfig()
  if (!config.paired || !config.token) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  await setConfig({ status: 'connecting', error: null })

  try {
    ws = new WebSocket('ws://127.0.0.1:3457/v1/live')

    ws.onopen = () => {
      // Do NOT set connected yet — wait for hello-ack
      const config_sync = getConfig()
      config_sync.then((c) => {
        if (c.token && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'hello', token: c.token } satisfies ExtensionToBridgeMessage))
        }
      })
    }

    ws.onmessage = async (event) => {
      try {
        const data = typeof event.data === 'string' ? event.data : await (event.data as Blob).text()
        const msg = JSON.parse(data) as BridgeToExtensionMessage
        if (msg.type === 'hello-ack') {
          authenticated = true
          await setConfig({ status: 'authenticated', error: null })
          startHeartbeat()
        } else if (msg.type === 'capture') {
          if (!authenticated) return
          performCapture(msg.requestId, 'mcp').catch(async (err) => {
            reportCaptureError(msg.requestId, String(err))
          })
        }
      } catch (e) {
        console.error('Failed to handle WS message', e)
      }
    }

    ws.onclose = () => {
      authenticated = false
      stopHeartbeat()
      setConfig({ status: 'disconnected' })
      ws = null
    }

    ws.onerror = () => {
      authenticated = false
      stopHeartbeat()
      setConfig({ status: 'error', error: 'WebSocket connection error' })
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    setConfig({ status: 'error', error: message })
  }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
      ws.send(JSON.stringify({ type: 'heartbeat' } satisfies ExtensionToBridgeMessage))
    }
  }, 20_000)
}

function stopHeartbeat() {
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
}

function sendWs(msg: ExtensionToBridgeMessage) {
  if (ws && ws.readyState === WebSocket.OPEN && authenticated) {
    ws.send(JSON.stringify(msg))
  }
}

function reportCaptureError(requestId: string, error: string) {
  sendWs({ type: 'capture-result', requestId, error })
  // Also surface to popup
  setConfig({ error: `Capture failed: ${error}` })
}

// ─── Pairing ─────────────────────────────────────────────────────────

const PAIRING_POLL_INTERVAL = 2000
const PAIRING_TIMEOUT_MINUTES = 2

async function pollPairing(pairId: string, secret: string) {
  const config = await getConfig()
  // Abort if no longer pairing
  if (config.status !== 'pairing' || config.pairId !== pairId) return

  try {
    const res = await fetch(`http://127.0.0.1:3457/v1/pair/${pairId}`, {
      headers: { 'X-Pairing-Secret': secret }
    })

    if (res.status === 200) {
      const body = await res.json()
      // Only treat as approved if there is actually a token
      if (body.token && typeof body.token === 'string') {
        await setConfig({
          paired: true,
          token: body.token,
          status: 'disconnected',
          pairId: null,
          pairingSecret: null,
          pairCode: null,
          expiresAt: null,
          error: null
        })
        chrome.alarms.clear('pairing-timeout')
        connectWs()
        return
      }
      // 200 but no token means still pending — continue polling
    }

    if (res.status === 404 || res.status === 403 || res.status === 400) {
      await setConfig({
        status: 'error',
        error: 'Pairing failed or expired',
        pairId: null,
        pairingSecret: null,
        pairCode: null,
        expiresAt: null
      })
      chrome.alarms.clear('pairing-timeout')
      return
    }

    // Any other status (including 202 pending) — keep polling
    setTimeout(() => pollPairing(pairId, secret), PAIRING_POLL_INTERVAL)
  } catch {
    // Network error, keep trying
    setTimeout(() => pollPairing(pairId, secret), PAIRING_POLL_INTERVAL)
  }
}

// On worker startup, resume pairing if it was in progress
;(async () => {
  const config = await getConfig()
  if (config.status === 'pairing' && config.pairId && config.pairingSecret) {
    pollPairing(config.pairId, config.pairingSecret)
  } else {
    connectWs()
  }
})()

// ─── Message handling from popup / content ───────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start-pairing') {
    ;(async () => {
      try {
        const secret = crypto.randomUUID()
        const res = await fetch('http://127.0.0.1:3457/v1/pair/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret })
        })
        if (!res.ok) throw new Error('Failed to request pairing')
        const { pairId, code, expiresAt } = await res.json()

        await setConfig({
          status: 'pairing',
          pairId,
          pairingSecret: secret,
          pairCode: code,
          expiresAt,
          error: null
        })

        // Set a 2-minute timeout alarm
        chrome.alarms.create('pairing-timeout', { delayInMinutes: PAIRING_TIMEOUT_MINUTES })

        sendResponse({ code })
        pollPairing(pairId, secret)
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e)
        await setConfig({ status: 'error', error: message })
        sendResponse({ error: message })
      }
    })()
    return true // async sendResponse
  }

  if (msg.type === 'get-status') {
    ;(async () => {
      const config = await getConfig()
      sendResponse({ status: config.status, error: config.error })
    })()
    return true
  }

  if (msg.type === 'reconnect') {
    ws?.close()
    ws = null
    authenticated = false
    stopHeartbeat()
    connectWs()
    return false
  }

  if (msg.type === 'page-navigated') {
    const url = msg.url as string
    // Only auto-sync from active user tabs — not temporary extraction tabs
    if (sender.tab && sender.tab.active && sender.tab.id !== undefined && !temporaryTabIds.has(sender.tab.id)) {
      handleAutoSync(url, sender.tab.id)
    }
    return false
  }

  if (msg.type === 'request-image-permission') {
    // This must be called from a popup gesture context
    const origins = msg.origins as string[]
    ;(async () => {
      try {
        const granted = await chrome.permissions.request({ origins })
        sendResponse({ granted })
      } catch (e: unknown) {
        sendResponse({ granted: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return true
  }

  return false
})

// ─── Auto-sync for active user tabs ──────────────────────────────────

let lastAutoSyncUrl = ''
let lastAutoSyncTime = 0
const AUTO_SYNC_DEBOUNCE_MS = 5000

async function handleAutoSync(url: string, tabId?: number) {
  const config = await getConfig()
  if (!config.paired || !config.autoSync) return

  // Parse URL to verify it's a task URL
  if (!isMondayTaskUrl(url)) return

  const now = Date.now()
  if (url === lastAutoSyncUrl && now - lastAutoSyncTime < AUTO_SYNC_DEBOUNCE_MS) return
  lastAutoSyncUrl = url
  lastAutoSyncTime = now

  // Give the page a moment to load
  setTimeout(() => {
    performCapture(undefined, 'auto', url).catch((err) => {
      console.error('Auto-sync capture failed:', err)
      setConfig({ error: `Auto-sync failed: ${err instanceof Error ? err.message : String(err)}` })
    })
  }, 3000)
}

// ─── URL parsing ─────────────────────────────────────────────────────

function isMondayTaskUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith('.monday.com')) return false
    // Match /boards/<id>/pulses/<id> in the path
    return /\/boards\/\d+(?:\/views\/\d+)?\/pulses\/\d+/.test(u.pathname)
  } catch {
    return false
  }
}

function parseMondayUrl(url: string): { accountHost: string; boardId: string; itemId: string } | null {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith('.monday.com')) return null
    const match = u.pathname.match(/\/boards\/(\d+)(?:\/views\/\d+)?\/pulses\/(\d+)/)
    if (!match) return null
    return {
      accountHost: u.hostname,
      boardId: match[1],
      itemId: match[2]
    }
  } catch {
    return null
  }
}

// ─── Capture ─────────────────────────────────────────────────────────

// Set of tab IDs that are temporary extraction tabs — content scripts must ignore these
const temporaryTabIds = new Set<number>()

async function performCapture(requestId?: string, reason: 'mcp' | 'auto' = 'mcp', sourceUrl?: string) {
  const captureDeadline = Date.now() + 150_000
  const config = await getConfig()
  if (!config.token) {
    if (requestId) reportCaptureError(requestId, 'Not authenticated')
    return
  }

  let targetUrl = sourceUrl

  if (!targetUrl) {
    // Find the active Monday tab with a task open
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const activeUrl = tabs[0]?.url || ''
    if (isMondayTaskUrl(activeUrl)) {
      targetUrl = activeUrl
    } else {
      // Search all Monday tabs for one with a task
      const mondayTabs = await chrome.tabs.query({ url: 'https://*.monday.com/*' })
      const taskTab = mondayTabs.find((t) => t.url && isMondayTaskUrl(t.url))
      if (taskTab?.url) {
        targetUrl = taskTab.url
      }
    }
  }

  if (!targetUrl) {
    if (requestId) reportCaptureError(requestId, 'No Monday task tab found')
    return
  }

  const parsed = parseMondayUrl(targetUrl)
  if (!parsed) {
    if (requestId) reportCaptureError(requestId, 'Could not parse Monday URL')
    return
  }

  let tempTabId: number | undefined
  try {
    // Open a temporary inactive tab for extraction
    const tab = await chrome.tabs.create({ url: targetUrl, active: false })
    tempTabId = tab.id
    if (tempTabId !== undefined) {
      temporaryTabIds.add(tempTabId)
    }

    // Wait for tab to load
    if ((await chrome.tabs.get(tempTabId!)).status !== 'complete') {
      await waitForTabLoad(tempTabId!, 15_000)
    }

    // Inject content script into temp tab (it may already be injected via manifest match,
    // but sendMessage will reach the injected one)
    // Small delay for content script initialization
    await delay(1000)

    // Send extract message
    let extractRes: ExtractResult
    try {
      extractRes = await Promise.race([
        chrome.tabs.sendMessage(tempTabId!, { type: 'extract-task' }) as Promise<ExtractResult>,
        delay(100_000).then((): never => { throw new Error('Task extraction timed out') })
      ])
    } catch (e) {
      throw new Error(`Content script communication failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (extractRes.error) throw new Error(extractRes.error)

    // Process results
    const { title, fields, updates, attachments: rawAttachments, warnings: contentWarnings } = extractRes

    const attachments: TaskAttachment[] = []
    const images: ImageUpload[] = []
    const warnings: string[] = [...(contentWarnings || [])]
    const maxImageBytes = 25 * 1024 * 1024
    const maxCaptureBytes = 75 * 1024 * 1024
    let captureBytes = 0

    for (const raw of rawAttachments) {
      // IDs must be unique across captures: the store uses them to locate original bytes.
      const attachmentId = crypto.randomUUID()
      if (!raw.url) {
        attachments.push({
          id: attachmentId,
          name: raw.name,
          mimeType: raw.mimeType || 'application/octet-stream',
          status: 'unavailable',
          error: 'No URL available for this attachment'
        })
        warnings.push(`Attachment "${raw.name}": no URL available`)
        continue
      }

      try {
        // Check permission for this origin before fetching
        const originUrl = new URL(raw.url)
        const originPattern = `${originUrl.origin}/*`
        const hasPermission = await chrome.permissions.contains({ origins: [originPattern] })

        if (!hasPermission) {
          // Track this origin so popup can request permission
          const pendingOrigins = new Set<string>(config.pendingOrigins)
          pendingOrigins.add(originPattern)
          await setConfig({ pendingOrigins: Array.from(pendingOrigins) })

          attachments.push({
            id: attachmentId,
            name: raw.name,
            mimeType: raw.mimeType || 'application/octet-stream',
            status: 'unavailable',
            error: `Missing host permission for ${originUrl.origin}`
          })
          warnings.push(`Attachment "${raw.name}": missing host permission for ${originUrl.origin}`)
          continue
        }

        if (Date.now() >= captureDeadline) throw new Error('Capture time limit reached')
        const res = await fetch(raw.url, {
          credentials: 'include',
          signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, captureDeadline - Date.now())))
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const advertisedBytes = Number(res.headers.get('content-length') || 0)
        if (advertisedBytes > maxImageBytes || captureBytes + advertisedBytes > maxCaptureBytes) {
          throw new Error('Original image exceeds the local capture size limit')
        }

        const buffer = await res.arrayBuffer()
        if (buffer.byteLength === 0) {
          throw new Error('Empty response body')
        }
        if (buffer.byteLength > maxImageBytes || captureBytes + buffer.byteLength > maxCaptureBytes) {
          throw new Error('Original image exceeds the local capture size limit')
        }
        // CDN downloads often use application/octet-stream. Identify the file
        // from its bytes, and leave unsupported formats explicitly unavailable.
        const contentType = detectImageMime(new Uint8Array(buffer))
        if (!contentType) throw new Error('Original file is not a supported PNG, JPEG, GIF or WebP image')
        captureBytes += buffer.byteLength

        // MV3 worker-safe base64 encoding using Uint8Array chunks + btoa
        const dataBase64 = arrayBufferToBase64(buffer)

        attachments.push({
          id: attachmentId,
          name: raw.name,
          mimeType: contentType,
          status: 'ready'
        })

        images.push({
          id: attachmentId,
          name: raw.name,
          mimeType: contentType,
          dataBase64
        })
      } catch (e) {
        attachments.push({
          id: attachmentId,
          name: raw.name,
          mimeType: raw.mimeType || 'application/octet-stream',
          status: 'unavailable',
          error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`
        })
        warnings.push(`Attachment "${raw.name}": fetch failed`)

      }
    }

    // Determine completeness: only true if no warnings and all attachments ready
    const allAttachmentsReady = attachments.length === 0 || attachments.every((a) => a.status === 'ready')
    const complete = allAttachmentsReady && warnings.length === 0

    const snapshot: TaskSnapshot = {
      sourceUrl: targetUrl,
      accountHost: parsed.accountHost,
      boardId: parsed.boardId,
      itemId: parsed.itemId,
      title,
      fields,
      updates,
      attachments,
      capturedAt: new Date().toISOString(),
      captureReason: reason,
      complete,
      warnings
    }

    const payload: CapturePayload = {
      requestId,
      snapshot,
      images
    }

    // POST to bridge
    const postRes = await fetch('http://127.0.0.1:3457/v1/snapshots', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`
      },
      body: JSON.stringify(payload)
    })

    if (!postRes.ok) throw new Error(`Bridge returned ${postRes.status}`)

    await setConfig({
      lastCaptureAt: snapshot.capturedAt,
      lastTaskTitle: snapshot.title,
      lastCaptureComplete: snapshot.complete,
      error: snapshot.complete ? null : `Capture incomplete: ${warnings[0] || 'original image unavailable'}`
    })

    if (requestId) {
      sendWs({ type: 'capture-result', requestId })
    }
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e)
    if (requestId) {
      reportCaptureError(requestId, errMsg)
    }
    await setConfig({ error: `Capture failed: ${errMsg}` })
  } finally {
    if (tempTabId !== undefined) {
      temporaryTabIds.delete(tempTabId)
      chrome.tabs.remove(tempTabId).catch(() => { /* tab may already be closed */ })
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────

interface ExtractResult {
  error?: string
  title: string
  fields: Record<string, string>
  updates: Array<{
    id: string
    author: string
    createdAt: string
    body: string
    replies: Array<{
      id: string
      author: string
      createdAt: string
      body: string
    }>
  }>
  attachments: Array<{
    id: string
    name: string
    mimeType: string
    url: string
  }>
  warnings: string[]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let resolved = false
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        chrome.tabs.onUpdated.removeListener(listener)
        chrome.tabs.onRemoved.removeListener(removedListener)
        reject(new Error('Task tab did not finish loading'))
      }
    }, timeoutMs)

    function listener(updatedTabId: number, info: { status?: string }) {
      if (updatedTabId === tabId && info.status === 'complete') {
        if (!resolved) {
          resolved = true
          clearTimeout(timer)
          chrome.tabs.onUpdated.removeListener(listener)
          chrome.tabs.onRemoved.removeListener(removedListener)
          resolve()
        }
      }
    }
    function removedListener(removedTabId: number) {
      if (removedTabId === tabId && !resolved) {
        resolved = true
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        chrome.tabs.onRemoved.removeListener(removedListener)
        reject(new Error('Task tab closed while loading'))
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.onRemoved.addListener(removedListener)
    chrome.tabs.get(tabId).then(tab => {
      if (!resolved && tab.status === 'complete') {
        resolved = true
        clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        chrome.tabs.onRemoved.removeListener(removedListener)
        resolve()
      }
    }).catch(() => removedListener(tabId))
  })
}

/**
 * Worker-safe base64 encoding. FileReader is NOT available in MV3 service workers.
 * Uses Uint8Array iteration with chunked btoa to avoid stack overflow on large buffers.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK_SIZE = 0x8000 // 32KB chunks to avoid call stack issues
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function detectImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}
