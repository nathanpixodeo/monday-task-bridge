import { getConfig, setConfig, defaultConfig, unpairedFields } from './helpers/storage'
import type { Config } from './helpers/storage'
import { ITEM_QUERY, mapItem } from './helpers/monday-api'
import type { ApiItem, MappedTask } from './helpers/monday-api'
import { readAssignedTasks } from './helpers/assigned-tasks'
import { writeBackToItem, WriteBackTargetError } from './helpers/write-back'
import type {
  TaskSnapshot,
  TaskAttachment,
  ImageUpload,
  CapturePayload,
  AssignedTasksPayload,
  ExtensionToBridgeMessage,
  BridgeToExtensionMessage
} from '../shared/types'

const BRIDGE_OFFLINE_MESSAGE = 'Cannot reach the bridge at 127.0.0.1:3457. Start it with: npm run bridge'

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
      error: 'Pairing code expired. Start pairing again.',
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
  if (!config.paired || !config.token || !config.enabled) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  // Power can be switched off while this write waits in the queue
  const current = await setConfig({ status: 'connecting', connectedAt: null })
  if (!current.enabled) {
    await setConfig({ status: 'disconnected' })
    return
  }

  try {
    const socket = new WebSocket('ws://127.0.0.1:3457/v1/live')
    ws = socket

    // A replaced socket can still fire events; it must not touch `ws` or the status.
    socket.onopen = () => {
      if (ws !== socket) return
      // Do NOT set connected yet — wait for hello-ack
      getConfig().then((c) => {
        if (c.token && ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'hello', token: c.token, capabilities: ['assignedTasks', 'boardFilter', 'writeBack'] } satisfies ExtensionToBridgeMessage))
        }
      })
    }

    socket.onmessage = async (event) => {
      if (ws !== socket) return
      try {
        const data = typeof event.data === 'string' ? event.data : await (event.data as Blob).text()
        const msg = JSON.parse(data) as BridgeToExtensionMessage
        if (msg.type === 'hello-ack') {
          authenticated = true
          await setConfig({ status: 'authenticated', error: null, connectedAt: new Date().toISOString() })
          startHeartbeat()
        } else if (msg.type === 'capture') {
          if (!authenticated) return
          // The bridge validates targets too; re-check so this worker only ever loads monday task pages
          if (msg.url !== undefined && !isMondayTaskUrl(msg.url)) {
            reportCaptureError(msg.requestId, 'Not a monday task URL')
            return
          }
          performCapture(msg.requestId, msg.url).catch(async (err) => {
            reportCaptureError(msg.requestId, String(err))
          })
        } else if (msg.type === 'list-assigned-tasks') {
          if (!authenticated) return
          listAssignedTasks(msg.requestId, msg.accountHost, msg.cachedHost, msg.boardIds, msg.boardsOnly).catch((err) => {
            reportAssignedTasksError(msg.requestId, err instanceof Error ? err.message : String(err))
          })
        } else if (msg.type === 'write-back') {
          if (!authenticated) return
          writeBack(msg).catch((err) => {
            reportWriteBackError(msg.requestId, err)
          })
        }
      } catch (e) {
        console.error('Failed to handle WS message', e)
      }
    }

    socket.onclose = (event) => {
      if (ws !== socket) return
      authenticated = false
      stopHeartbeat()
      ws = null
      // 4003 invalid token, 4004 unpaired, 4005 pairing replaced: the token is dead for good
      if (event.code === 4003 || event.code === 4004 || event.code === 4005) {
        setConfig({ ...unpairedFields, error: 'The bridge no longer accepts this browser. Pair again.' })
      } else {
        setConfig({ status: 'disconnected', connectedAt: null })
      }
    }

    socket.onerror = () => {
      if (ws !== socket) return
      authenticated = false
      stopHeartbeat()
      setConfig({ status: 'error', connectedAt: null })
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    setConfig({ status: 'error', error: message })
  }
}

/** Close the live socket without letting its handlers touch status or `ws`. */
function disconnectWs() {
  if (ws) {
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    ws.close()
    ws = null
  }
  authenticated = false
  stopHeartbeat()
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

function reportAssignedTasksError(requestId: string, error: string, code?: 'INVALID_TARGET') {
  sendWs({ type: 'assigned-tasks-error', requestId, error, code })
  setConfig({ error: `Listing assigned tasks failed: ${error}` })
}

// ─── Toolbar badge ───────────────────────────────────────────────────

function badgeFor(config: Config): { text: string; color: string; title: string } {
  if (!config.paired && config.status === 'pairing') {
    return { text: '…', color: '#7C3AED', title: 'Waiting for pairing approval' }
  }
  if (!config.paired) return { text: '', color: '#64748B', title: 'Not paired' }
  if (!config.enabled) return { text: '', color: '#64748B', title: 'Disconnected' }
  if (config.status !== 'authenticated') return { text: '!', color: '#E11D48', title: 'Bridge offline' }
  if (config.pendingOrigins.length > 0) return { text: '+', color: '#D97706', title: 'Image host permission needed' }
  if (config.capturing) return { text: '…', color: '#7C3AED', title: 'Capturing task' }
  if (config.lastCaptureComplete === false) return { text: '!', color: '#D97706', title: 'Last capture incomplete' }
  return { text: '', color: '#16A34A', title: 'Connected' }
}

let iconVariant: 'on' | 'off' | null = null

function updateBadge(config: Config) {
  const { text, color, title } = badgeFor(config)
  void chrome.action.setBadgeText({ text })
  void chrome.action.setBadgeBackgroundColor({ color })
  void chrome.action.setBadgeTextColor({ color: '#FFFFFF' })
  void chrome.action.setTitle({ title: `Monday Task Bridge: ${title}` })

  // The toolbar icon color mirrors the connection, like a VPN toggle
  const connected = config.paired && config.enabled && config.status === 'authenticated'
  const variant = connected ? 'on' : 'off'
  if (variant !== iconVariant) {
    iconVariant = variant
    void chrome.action.setIcon({
      path: connected
        ? { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }
        : { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' }
    })
  }
}

chrome.storage.local.onChanged.addListener((changes) => {
  const next = changes.config?.newValue as Partial<Config> | undefined
  if (next) updateBadge({ ...defaultConfig, ...next })
})

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
          enabled: true,
          // connectWs runs next; 'connecting' avoids a flash of the offline state after pairing
          status: 'connecting',
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
        error: 'Pairing code expired or was rejected. Start pairing again.',
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
  // A restarted worker has no capture in flight
  const config = await setConfig({ capturing: false })
  if (config.status === 'pairing' && config.pairId && config.pairingSecret) {
    pollPairing(config.pairId, config.pairingSecret)
  } else {
    connectWs()
  }
  updateBadge(await getConfig())
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
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(typeof body?.error === 'string' ? body.error : `Bridge returned HTTP ${res.status}`)
        }
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
        // fetch rejects with a TypeError when nothing listens on the bridge port
        const message = e instanceof TypeError ? BRIDGE_OFFLINE_MESSAGE : e instanceof Error ? e.message : String(e)
        await setConfig({ status: 'error', error: message })
        sendResponse({ error: message })
      }
    })()
    return true // async sendResponse
  }

  if (msg.type === 'cancel-pairing') {
    ;(async () => {
      chrome.alarms.clear('pairing-timeout')
      await setConfig({
        status: 'disconnected',
        error: null,
        pairId: null,
        pairingSecret: null,
        pairCode: null,
        expiresAt: null
      })
      sendResponse({ ok: true })
    })()
    return true
  }

  if (msg.type === 'unpair') {
    ;(async () => {
      const { token } = await getConfig()
      disconnectWs()
      chrome.alarms.clear('pairing-timeout')
      // Clear local state before the network call so the reconnect alarm cannot reuse the old token
      await setConfig(unpairedFields)
      let revoked = true
      if (token) {
        try {
          const res = await fetch('http://127.0.0.1:3457/v1/unpair', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000)
          })
          // 403: the bridge already rejects this token (rotated, or another extension paired)
          revoked = res.ok || res.status === 403
        } catch {
          revoked = false
        }
      }
      sendResponse({ revoked })
    })()
    return true
  }

  if (msg.type === 'set-enabled') {
    ;(async () => {
      if (msg.enabled === true) {
        // Write 'connecting' with the switch so the popup never flashes the offline state in between
        await setConfig({ enabled: true, status: 'connecting' })
        connectWs()
      } else {
        disconnectWs()
        await setConfig({ enabled: false, status: 'disconnected', connectedAt: null })
      }
      sendResponse({ ok: true })
    })()
    return true
  }

  if (msg.type === 'clear-error') {
    ;(async () => {
      const config = await getConfig()
      await setConfig(config.status === 'error' ? { error: null, status: 'disconnected' } : { error: null })
      sendResponse({ ok: true })
    })()
    return true
  }

  if (msg.type === 'permissions-granted') {
    ;(async () => {
      const { pendingOrigins } = await getConfig()
      const granted = await Promise.all(
        pendingOrigins.map((origin) => chrome.permissions.contains({ origins: [origin] }))
      )
      await setConfig({ pendingOrigins: pendingOrigins.filter((_, i) => !granted[i]) })
      sendResponse({ ok: true })
    })()
    return true
  }

  if (msg.type === 'get-status') {
    ;(async () => {
      const config = await getConfig()
      sendResponse({ status: config.status, error: config.error })
    })()
    return true
  }

  if (msg.type === 'reconnect') {
    disconnectWs()
    connectWs()
    return false
  }

  return false
})

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

// Agent reads can overlap; `capturing` stays true until the last one ends
let activeCaptures = 0

/**
 * monday's web app sends `x-csrf-token` on its API calls. Like other Rails apps it embeds the token in
 * the app page, so read it from there. The token stays inside the extension; callers get the source only.
 */
async function fetchCsrfToken(host: string): Promise<{ token: string | null; source: string }> {
  const res = await fetch(`https://${host}/`, { credentials: 'include', signal: AbortSignal.timeout(20_000) })
  const html = await res.text()
  const meta =
    html.match(/<meta[^>]+name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i)
  if (meta) return { token: meta[1], source: 'meta tag' }
  const inline = html.match(/csrf[_-]?token["']?\s*[:=]\s*["']([^"']{16,})["']/i)
  if (inline) return { token: inline[1], source: 'inline script' }
  return { token: null, source: `not found in ${html.length} bytes of HTML (status ${res.status})` }
}

// ─── monday API reader ───────────────────────────────────────────────

/** CSRF tokens per account host; one token lasts the whole monday session. */
const csrfTokens = new Map<string, string>()

async function csrfTokenFor(host: string, refresh: boolean): Promise<string> {
  const cached = csrfTokens.get(host)
  if (cached && !refresh) return cached
  const { token } = await fetchCsrfToken(host)
  // The app page only carries a token for a signed-in user
  if (!token) throw new Error(`Not signed in to ${host} in this Chrome profile. Sign in to monday and try again.`)
  csrfTokens.set(host, token)
  return token
}

/** Calls monday's GraphQL endpoint the way its web app does: session cookie plus `x-csrf-token`. */
async function mondayGraphql<T>(host: string, query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://${host}/v2`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': await csrfTokenFor(host, attempt > 0) },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000)
    })
    // A rejected token usually means the session was renewed; fetch a fresh one once
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message?: string }> }
    if (!res.ok || body.errors?.length || !body.data) {
      throw new Error(`monday API: ${body.errors?.[0]?.message ?? `HTTP ${res.status}`}`)
    }
    return body.data
  }
}

async function readTaskViaApi(host: string, itemId: string): Promise<MappedTask> {
  const data = await mondayGraphql<{ items: ApiItem[] }>(host, ITEM_QUERY, { ids: [itemId] })
  const item = data.items?.[0]
  if (!item) throw new Error(`monday has no task ${itemId} that this account can see`)
  return mapItem(item)
}

/** The task open in the active tab of the current window, else the first open monday task tab. */
async function findTaskTabUrl(): Promise<string | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const activeUrl = tabs[0]?.url || ''
  if (isMondayTaskUrl(activeUrl)) return activeUrl
  const mondayTabs = await chrome.tabs.query({ url: 'https://*.monday.com/*' })
  return mondayTabs.find((t) => t.url && isMondayTaskUrl(t.url))?.url
}

async function performCapture(requestId?: string, sourceUrl?: string) {
  const captureDeadline = Date.now() + 150_000
  const config = await getConfig()
  if (!config.token) {
    if (requestId) reportCaptureError(requestId, 'Not authenticated')
    return
  }

  const targetUrl = sourceUrl ?? await findTaskTabUrl()
  if (!targetUrl) {
    if (requestId) reportCaptureError(requestId, 'No Monday task tab found')
    return
  }

  const parsed = parseMondayUrl(targetUrl)
  if (!parsed) {
    if (requestId) reportCaptureError(requestId, 'Could not parse Monday URL')
    return
  }

  activeCaptures++
  try {
    await setConfig({ capturing: true })
    // Read the task through monday's API with the browser session: no tab, no page rendering
    const extractRes: ExtractResult = await readTaskViaApi(parsed.accountHost, parsed.itemId)

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
          // Track this origin so popup can request permission. Re-read the list: the copy from
          // capture start would drop origins added for earlier attachments or cleared by a grant.
          const pendingOrigins = new Set<string>((await getConfig()).pendingOrigins)
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
      captureReason: 'mcp',
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
      lastWarnings: warnings,
      error: null
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
    activeCaptures--
    await setConfig({ capturing: activeCaptures > 0 })
  }
}

// ─── Assigned tasks ──────────────────────────────────────────────────

// monday's marketing site and login page share the domain but are not accounts
const NON_ACCOUNT_HOSTS = new Set(['www.monday.com', 'auth.monday.com'])

function accountHostOf(url: string): string | null {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.monday\.com$/.test(host) || NON_ACCOUNT_HOSTS.has(host)) return null
    return host
  } catch {
    return null
  }
}

/** The monday account open in the active tab of the current window, else in any open monday tab. */
async function findAccountHost(): Promise<string | undefined> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const mondayTabs = await chrome.tabs.query({ url: 'https://*.monday.com/*' })
  for (const tab of [active, ...mondayTabs]) {
    const host = tab?.url ? accountHostOf(tab.url) : null
    if (host) return host
  }
  return undefined
}

/** Lists the user's assigned tasks and posts them to the bridge, which relays them without storing. */
async function listAssignedTasks(
  requestId: string,
  accountHost?: string,
  cachedHost?: string,
  boardIds?: string[],
  boardsOnly?: boolean
) {
  const config = await getConfig()
  if (!config.token) {
    reportAssignedTasksError(requestId, 'Not authenticated')
    return
  }

  const host = accountHost ?? (await findAccountHost()) ?? cachedHost
  if (!host) {
    reportAssignedTasksError(
      requestId,
      'No monday account to read: pass accountHost (e.g. team.monday.com), or open monday.com in this Chrome profile',
      'INVALID_TARGET'
    )
    return
  }

  activeCaptures++
  try {
    await setConfig({ capturing: true })
    const result = await readAssignedTasks(host, mondayGraphql, { boardIds, boardsOnly })
    const res = await fetch('http://127.0.0.1:3457/v1/assigned-tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.token}`
      },
      body: JSON.stringify({ requestId, result } satisfies AssignedTasksPayload)
    })
    if (!res.ok) throw new Error(`Bridge returned ${res.status}`)
    await setConfig({ error: null })
  } finally {
    activeCaptures--
    await setConfig({ capturing: activeCaptures > 0 })
  }
}

// ─── Write back ──────────────────────────────────────────────────────

/** Writes the status and the update the Hub asked for to one item, and tells the bridge what was written. */
async function writeBack(msg: Extract<BridgeToExtensionMessage, { type: 'write-back' }>) {
  const { requestId, accountHost, boardId, itemId, comment, statusLabel } = msg
  // The bridge validates the target too; re-check so this worker only ever writes to a monday account
  if (accountHostOf(`https://${accountHost}/`) !== accountHost.toLowerCase()) {
    sendWs({ type: 'write-back-result', requestId, error: `${accountHost} is not a monday account`, code: 'INVALID_TARGET' })
    return
  }
  activeCaptures++
  try {
    await setConfig({ capturing: true })
    const result = await writeBackToItem(mondayGraphql, { accountHost, boardId, itemId, comment, statusLabel })
    sendWs({ type: 'write-back-result', requestId, result })
    await setConfig({ error: null })
  } finally {
    activeCaptures--
    await setConfig({ capturing: activeCaptures > 0 })
  }
}

function reportWriteBackError(requestId: string, err: unknown) {
  const error = err instanceof Error ? err.message : String(err)
  sendWs({ type: 'write-back-result', requestId, error, code: err instanceof WriteBackTargetError ? 'INVALID_TARGET' : undefined })
  setConfig({ error: `Writing back to monday failed: ${error}` })
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
