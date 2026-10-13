import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { AssignedTasks, BridgeToExtensionMessage, TaskSnapshot } from '../shared/types.js'

const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

function assignedTasks(accountHost: string): AssignedTasks {
  return {
    accountHost,
    user: { id: '1', name: 'Alice' },
    tasks: [{
      accountHost, boardId: '123', boardName: 'Sprint', itemId: '456', title: 'Example task',
      sourceUrl: `https://${accountHost}/boards/123/pulses/456`, fields: { Status: 'Working on it' }
    }],
    warnings: [],
    complete: true,
    checkedAt: new Date().toISOString()
  }
}

/** Parsed JSON of a tool result's text block. */
function toolText(content: unknown): unknown {
  const text = (content as Array<{ type: string; text?: string }>).find(block => block.type === 'text')?.text
  assert.ok(text)
  return JSON.parse(text)
}

test('older extension without assignedTasks capability receives immediate helpful error and no list command', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-old-ext-'))
  const previousDir = process.env.MONDAY_BRIDGE_DATA_DIR
  const previousPort = process.env.MONDAY_BRIDGE_PORT
  process.env.MONDAY_BRIDGE_DATA_DIR = dataDir
  const port = await freePort()
  process.env.MONDAY_BRIDGE_PORT = String(port)

  const { startServer, closeServer, store } = await import('../bridge/server.js')
  const server = await startServer()
  const base = `http://127.0.0.1:${port}`
  let ws: WebSocket | undefined

  try {
    const adminHeaders = { 'X-Bridge-Admin-Token': await store.getAdminToken() }
    const token = await store.rotateBridgeToken()
    ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: extensionOrigin })
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => resolve())
      ws!.once('error', reject)
    })

    const receivedCommands: BridgeToExtensionMessage[] = []
    ws.on('message', data => {
      try { receivedCommands.push(JSON.parse(data.toString())) } catch {}
    })

    const ackPromise = new Promise<BridgeToExtensionMessage>((resolve) => {
      const handler = (data: WebSocket.RawData) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'hello-ack') {
          ws!.off('message', handler)
          resolve(msg)
        }
      }
      ws!.on('message', handler)
    })

    // Old extension connects without capabilities
    ws.send(JSON.stringify({ type: 'hello', token }))
    assert.equal((await ackPromise).type, 'hello-ack')

    // Health check reports assignedTasksSupported as false
    const healthRes = await fetch(`${base}/health`)
    assert.equal(healthRes.status, 200)
    const healthJson = await healthRes.json()
    assert.equal(healthJson.extensionConnected, true)
    assert.equal(healthJson.assignedTasksSupported, false)

    // Requesting assigned tasks immediately returns 502 with helpful error
    const res = await fetch(`${base}/v1/list-assigned-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ accountHost: 'team.monday.com' })
    })
    assert.equal(res.status, 502)
    const errBody = await res.json()
    assert.equal(
      errBody.error,
      'EXTENSION_UPDATE_REQUIRED: Reload Monday Task Bridge in chrome://extensions to enable assigned tasks'
    )

    // Verify no list-assigned-tasks command was sent over the websocket
    const listCommands = receivedCommands.filter(c => c.type === 'list-assigned-tasks')
    assert.equal(listCommands.length, 0)
  } finally {
    ws?.terminate()
    await closeServer(server)
    if (previousDir === undefined) delete process.env.MONDAY_BRIDGE_DATA_DIR
    else process.env.MONDAY_BRIDGE_DATA_DIR = previousDir
    if (previousPort === undefined) delete process.env.MONDAY_BRIDGE_PORT
    else process.env.MONDAY_BRIDGE_PORT = previousPort
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep))
    await rm(dataDir, { recursive: true, force: true })
  }
})

