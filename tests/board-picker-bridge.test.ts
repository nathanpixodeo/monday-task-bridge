import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'
import type { AssignedTasks, BridgeToExtensionMessage } from '../shared/types.js'

const extensionOrigin = `chrome-extension://${'b'.repeat(32)}`

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

test('the board picker lists boards and reads one board through an extension that filters boards', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-boards-'))
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
    ws.send(JSON.stringify({ type: 'hello', token, capabilities: ['assignedTasks', 'boardFilter'] }))
    assert.equal((await ack).type, 'hello-ack')

    const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>
    assert.equal(health.boardFilterSupported, true)
    // Run from source the server is a 'dev' build, and says which process it is
    assert.equal(health.build, 'dev')
    assert.equal(health.pid, process.pid)

    // A choice the bridge cannot pass on is refused before it reaches the extension
    assert.equal((await send('/v1/list-assigned-tasks', { boardIds: ['abc'] }, adminHeaders)).status, 400)
    assert.equal((await send('/v1/list-assigned-tasks', { boardIds: [] }, adminHeaders)).status, 400)
    assert.equal((await send('/v1/list-assigned-tasks', { boardsOnly: true, boardIds: ['1'] }, adminHeaders)).status, 400)

    // The boards to choose from
    const boardsRead = send('/v1/list-assigned-tasks', { accountHost: 'team.monday.com', boardsOnly: true }, adminHeaders)
    const boardsCommand = await nextCommand()
    assert.deepEqual(boardsCommand, {
      type: 'list-assigned-tasks', requestId: boardsCommand.requestId, accountHost: 'team.monday.com', boardsOnly: true
    })
    const boards: AssignedTasks = {
      accountHost: 'team.monday.com', user: { id: '1', name: 'Alice' }, tasks: [],
      boards: [{ id: '123', name: 'Sprint', workspace: 'Engineering' }, { id: '456', name: 'Ops', workspace: null }],
      warnings: [], complete: true, checkedAt: new Date().toISOString()
    }
    assert.equal((await send('/v1/assigned-tasks', { requestId: boardsCommand.requestId, result: boards }, extensionHeaders)).status, 200)
    const boardsResponse = await boardsRead
    assert.equal(boardsResponse.status, 200)
    assert.deepEqual(await boardsResponse.json(), boards)

    // One chosen board
    const boardRead = send('/v1/list-assigned-tasks', { accountHost: 'team.monday.com', boardIds: ['123'] }, adminHeaders)
    const boardCommand = await nextCommand()
    assert.deepEqual(boardCommand, {
      type: 'list-assigned-tasks', requestId: boardCommand.requestId, accountHost: 'team.monday.com', boardIds: ['123']
    })
    const tasks: AssignedTasks = { ...boards, boards: undefined, tasks: [] }
    delete tasks.boards
    assert.equal((await send('/v1/assigned-tasks', { requestId: boardCommand.requestId, result: tasks }, extensionHeaders)).status, 200)
    assert.equal((await boardRead).status, 200)
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
