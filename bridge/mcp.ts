/**
 * bridge/mcp.ts – MCP stdio server exposing Monday bridge tools.
 *
 * Tools:
 *   monday_read_open_task   – request live capture from extension
 *   monday_read_task        – capture any task by URL or board+item ID
 *   monday_list_assigned_tasks – list tasks assigned to the signed-in user (live, not stored)
 *   monday_get_task         – retrieve stored snapshot (optional boardId/itemId)
 *   monday_get_image        – return original image bytes as ImageContent
 *   monday_list_tasks       – list stored snapshots
 *   monday_bridge_status    – bridge health/connection status
 *
 * The HTTP bridge is started automatically (detached) when a tool needs it and it is not
 * running; tools that only read the local store never start it.
 *
 * stdout is reserved for MCP JSON-RPC frames only.
 * All diagnostic output goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ensureBridge } from './autostart.js'
import { Store } from './store.js'
import type { StoredSnapshot } from './store.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BRIDGE_BASE = `http://127.0.0.1:${process.env.MONDAY_BRIDGE_PORT ?? '3457'}`

const store = new Store()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bridgeFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BRIDGE_BASE}${path}`, options)
}

async function getAdminToken(): Promise<string> {
  return store.getAdminToken()
}

let bridgeCheck: Promise<void> | undefined

/**
 * Makes sure the HTTP bridge is up, starting it when it is not. Concurrent tool calls share one
 * attempt, but nothing is cached afterwards: each call re-checks the cheap local /health, so a
 * bridge that stopped since the last call is started again instead of failing until a restart.
 */
async function bridgeReady(): Promise<void> {
  bridgeCheck ??= ensureBridge({ base: BRIDGE_BASE, dataDir: store.dataDir })
    .then(({ started, pid }) => {
      if (started) process.stderr.write(`[mcp] Started bridge pid=${pid}\n`)
    })
    .finally(() => {
      bridgeCheck = undefined
    })
  await bridgeCheck
}

const BRIDGE_UNAVAILABLE = 'BRIDGE_UNAVAILABLE'

/** Tool result for a bridge that could not be started, or null when the error is something else. */
function bridgeUnavailableResult(err: unknown) {
  if (!(err instanceof Error) || !err.message.startsWith(`${BRIDGE_UNAVAILABLE}:`)) return null
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: BRIDGE_UNAVAILABLE, message: err.message }) }],
    isError: true,
  }
}

function snapshotSummary(s: StoredSnapshot): object {
  return {
    requestId: s.requestId,
    boardId: s.snapshot.boardId,
    itemId: s.snapshot.itemId,
    title: s.snapshot.title,
    capturedAt: s.snapshot.capturedAt,
    complete: s.snapshot.complete,
    warnings: s.snapshot.warnings,
    fieldCount: Object.keys(s.snapshot.fields).length,
    updateCount: s.snapshot.updates.length,
    imageCount: s.imageIds.length,
    storedAt: s.storedAt,
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new McpServer({
  name: 'monday-task-bridge',
  version: '0.3.0',
})

/** POST a live-read request to the bridge, which relays it to the connected extension. */
async function captureVia(path: string, body?: unknown, failureMessage = 'Failed to capture task') {
  try {
    await bridgeReady()
    const adminToken = await getAdminToken()
    const res = await bridgeFetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Admin-Token': adminToken,
      },
      body: JSON.stringify(body ?? {}),
    })

    if (!res.ok) {
      const resBody = await res.json().catch(() => ({})) as Record<string, unknown>
      const errCode = (resBody.error as string) || `HTTP ${res.status}`
      if (errCode === 'BROWSER_OFFLINE') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'BROWSER_OFFLINE', message: 'No browser extension is connected. Ensure the Monday Task Bridge extension is running.' }) }],
          isError: true,
        }
      }
      if (res.status === 400) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'INVALID_TARGET', message: errCode }) }],
          isError: true,
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: errCode, message: failureMessage }) }],
        isError: true,
      }
    }

    const data = await res.json()
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  } catch (err: unknown) {
    const unavailable = bridgeUnavailableResult(err)
    if (unavailable) return unavailable
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NO_SNAPSHOT', message: msg }) }],
      isError: true,
    }
  }
}

// -- monday_read_open_task --------------------------------------------------

mcp.tool(
  'monday_read_open_task',
  'Request the browser extension to capture the currently open Monday.com task. ' +
    'Sends a capture request over WebSocket, waits up to 180s, and returns the snapshot.',
  {},
  async () => captureVia('/v1/read-open-task')
)

// -- monday_read_task -------------------------------------------------------

mcp.tool(
  'monday_read_task',
  'Capture any Monday.com task by URL or board+item ID without the user opening it. ' +
    'The extension reads it through the monday web API with the signed-in Chrome session; no tab opens. ' +
    'Requires Chrome running with the extension connected (power on). Waits up to 180s.',
  {
    url: z.string().optional().describe('Full monday task URL, e.g. https://team.monday.com/boards/123/pulses/456'),
    boardId: z.string().optional().describe('Monday.com board ID'),
    itemId: z.string().optional().describe('Monday.com item ID'),
    accountHost: z.string().optional().describe('e.g. team.monday.com; defaults to the host of the latest cached task'),
  },
  async ({ url, boardId, itemId, accountHost }) =>
    captureVia('/v1/read-task', { url, boardId, itemId, accountHost })
)

// -- monday_list_assigned_tasks ---------------------------------------------

mcp.tool(
  'monday_list_assigned_tasks',
  'List the tasks assigned to the signed-in monday user: items on active boards where any people column contains them. ' +
    'Read through the monday web API with the signed-in Chrome session; nothing is cached. ' +
    'Check `complete` and `warnings`: caps (100 boards, 1000 tasks, 120s) and unreadable boards make the list partial. ' +
    'Requires Chrome running with the extension connected (power on). Waits up to 180s.',
  {
    accountHost: z.string().optional().describe('e.g. team.monday.com; defaults to the host of an open monday tab, then of the latest cached task'),
  },
  async ({ accountHost }) =>
    captureVia('/v1/list-assigned-tasks', { accountHost }, 'Failed to list assigned tasks')
)

// -- monday_get_task --------------------------------------------------------

mcp.tool(
  'monday_get_task',
  'Get a stored Monday.com task snapshot. Filter by boardId and/or itemId. ' +
    'Without a filter, returns the latest captured task.',
  {
    boardId: z.string().optional().describe('Monday.com board ID'),
    itemId: z.string().optional().describe('Monday.com item ID'),
  },
  async ({ boardId, itemId }) => {
    try {
      await store.init()
      let snap: StoredSnapshot | null

      if (boardId || itemId) {
        snap = await store.findSnapshotByBoardItem(boardId, itemId)
      } else {
        snap = await store.getLatestSnapshot()
      }

      if (!snap) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NO_SNAPSHOT', message: 'No snapshot found' }) }],
          isError: true,
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          snapshot: snap.snapshot,
          imageCount: snap.imageIds.length,
          capturedAt: snap.snapshot.capturedAt,
          complete: snap.snapshot.complete,
          warnings: snap.snapshot.warnings,
          storedAt: snap.storedAt,
        }, null, 2) }],
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NO_SNAPSHOT', message: msg }) }],
        isError: true,
      }
    }
  }
)

// -- monday_get_image -------------------------------------------------------

mcp.tool(
  'monday_get_image',
  'Get the original image bytes for an image attachment from a stored snapshot. ' +
    'Returns ImageContent with the original base64 data.',
  {
    imageId: z.string().describe('Image upload ID from the snapshot'),
  },
  async ({ imageId }) => {
    try {
      await store.init()
      const buf = await store.getImageBytes(imageId)
      if (!buf) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'IMAGE_ORIGINAL_UNAVAILABLE', message: `Image ${imageId} not found in store` }) }],
          isError: true,
        }
      }

      // Try to detect MIME from first bytes
      let mimeType = 'image/png'
      if (buf[0] === 0xFF && buf[1] === 0xD8) mimeType = 'image/jpeg'
      else if (buf[0] === 0x89 && buf[1] === 0x50) mimeType = 'image/png'
      else if (buf[0] === 0x47 && buf[1] === 0x49) mimeType = 'image/gif'
      else if (buf[0] === 0x52 && buf[1] === 0x49) mimeType = 'image/webp'

      return {
        content: [{
          type: 'image' as const,
          data: buf.toString('base64'),
          mimeType,
        }],
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'IMAGE_ORIGINAL_UNAVAILABLE', message: msg }) }],
        isError: true,
      }
    }
  }
)

// -- monday_list_tasks ------------------------------------------------------

mcp.tool(
  'monday_list_tasks',
  'List all stored Monday.com task snapshots with summary information.',
  {},
  async () => {
    try {
      await store.init()
      const all = await store.listSnapshots()
      if (!all.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ tasks: [], message: 'No snapshots stored' }) }],
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          tasks: all.map(snapshotSummary),
          count: all.length,
        }, null, 2) }],
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'NO_SNAPSHOT', message: msg }) }],
        isError: true,
      }
    }
  }
)

// -- monday_bridge_status ---------------------------------------------------

mcp.tool(
  'monday_bridge_status',
  'Check the status of the Monday Task Bridge server and extension connection.',
  {},
  async () => {
    try {
      await bridgeReady()
      const res = await bridgeFetch('/health')
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'BROWSER_OFFLINE', message: 'Bridge server not responding' }) }],
          isError: true,
        }
      }
      const data = await res.json()
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
    } catch (err: unknown) {
      const unavailable = bridgeUnavailableResult(err)
      if (unavailable) return unavailable
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: 'BROWSER_OFFLINE',
          message: 'Cannot connect to bridge server at ' + BRIDGE_BASE,
        }) }],
        isError: true,
      }
    }
  }
)

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await store.init()
  process.stderr.write('[mcp] Starting MCP stdio server...\n')
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  process.stderr.write('[mcp] MCP server connected via stdio.\n')
}

main().catch((err) => {
  process.stderr.write(`[mcp] Fatal: ${err}\n`)
  process.exit(1)
})
