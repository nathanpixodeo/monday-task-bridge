import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'
import type { AssignedTasks, BridgeToExtensionMessage } from '../shared/types.js'

const extensionOrigin = `chrome-extension://${'c'.repeat(32)}`

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

test('the bridge relays a listing of every item of one board, or of some of its groups', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-board-items-'))
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
    const send = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    const adminHeaders = { 'X-Bridge-Admin-Token': await store.getAdminToken() }
    const token = await store.rotateBridgeToken()
    const extensionHeaders = { Origin: extensionOrigin, Authorization: `Bearer ${token}` }
    ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: extensionOrigin })
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => resolve())
      ws!.once('error', reject)
    })
    const nextCommand = () => new Promise<BridgeToExtensionMessage & { requestId: string }>((resolve, reject) => {
      ws!.once('message', data => {
        try { resolve(JSON.parse(data.toString())) } catch (error) { reject(error) }
      })
    })
    const ack = nextCommand()
    ws.send(JSON.stringify({ type: 'hello', token, capabilities: ['assignedTasks', 'boardFilter', 'boardItems'] }))
    assert.equal((await ack).type, 'hello-ack')

    const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>
    assert.equal(health.boardItemsSupported, true)

    // Every item reads exactly one board; groups only go with it
    assert.equal((await send('/v1/list-assigned-tasks', { everyItem: true }, adminHeaders)).status, 400)
    assert.equal((await send('/v1/list-assigned-tasks', { boardIds: ['1', '2'], everyItem: true }, adminHeaders)).status, 400)
    assert.equal((await send('/v1/list-assigned-tasks', { boardIds: ['1'], groups: ['topics'] }, adminHeaders)).status, 400)

    const read = send('/v1/list-assigned-tasks', {
      accountHost: 'team.monday.com', boardIds: ['123'], everyItem: true, groups: ['SUPERLEADER']
    }, adminHeaders)
    const command = await nextCommand()
    assert.deepEqual(command, {
      type: 'list-assigned-tasks', requestId: command.requestId, accountHost: 'team.monday.com',
      boardIds: ['123'], everyItem: true, groups: ['SUPERLEADER']
    })
    const result: AssignedTasks = {
      accountHost: 'team.monday.com', user: { id: '1', name: 'Alice' },
      tasks: [{
        accountHost: 'team.monday.com', boardId: '123', boardName: 'Sprint', itemId: '456', title: 'Not mine',
        sourceUrl: 'https://team.monday.com/boards/123/pulses/456', fields: { Owner: 'Bob' }
      }],
      warnings: [], complete: true, checkedAt: new Date().toISOString()
    }
    assert.equal((await send('/v1/assigned-tasks', { requestId: command.requestId, result }, extensionHeaders)).status, 200)
    const response = await read
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), result)
  } finally {
    ws?.close()
    await closeServer(server)
    if (previousDir === undefined) delete process.env.MONDAY_BRIDGE_DATA_DIR
    else process.env.MONDAY_BRIDGE_DATA_DIR = previousDir
    if (previousPort === undefined) delete process.env.MONDAY_BRIDGE_PORT
    else process.env.MONDAY_BRIDGE_PORT = previousPort
    await rm(dataDir, { recursive: true, force: true })
  }
})
