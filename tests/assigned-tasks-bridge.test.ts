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

test('assigned tasks are relayed from the extension to the bridge and MCP without being stored', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-assigned-'))
  const previousDir = process.env.MONDAY_BRIDGE_DATA_DIR
  const previousPort = process.env.MONDAY_BRIDGE_PORT
  process.env.MONDAY_BRIDGE_DATA_DIR = dataDir
  const port = await freePort()
  process.env.MONDAY_BRIDGE_PORT = String(port)

  const { startServer, closeServer, store } = await import('../bridge/server.js')
  const server = await startServer()
  const base = `http://127.0.0.1:${port}`
  let ws: WebSocket | undefined
  let client: Client | undefined

  try {
    const send = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    const adminHeaders = { 'X-Bridge-Admin-Token': await store.getAdminToken() }

    // A paired extension: the token is issued directly instead of through the pairing flow
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
    ws.send(JSON.stringify({ type: 'hello', token, capabilities: ['assignedTasks'] }))
    assert.equal((await ack).type, 'hello-ack')

    assert.equal((await send('/v1/list-assigned-tasks', {})).status, 403)
    assert.equal((await send('/v1/list-assigned-tasks', { accountHost: 'evil.example' }, adminHeaders)).status, 400)
    assert.equal((await send('/v1/list-assigned-tasks', { accountHost: 'team.monday.com/x' }, adminHeaders)).status, 400)

    // Explicit host: the list comes back over HTTP and is not stored
    const result = assignedTasks('team.monday.com')
    const listRead = send('/v1/list-assigned-tasks', { accountHost: 'team.monday.com' }, adminHeaders)
    const command = await nextCommand()
    assert.deepEqual(command, { type: 'list-assigned-tasks', requestId: command.requestId, accountHost: 'team.monday.com' })

    assert.equal((await send('/v1/assigned-tasks', { requestId: command.requestId, result }, {
      Origin: extensionOrigin, Authorization: 'Bearer wrong'
    })).status, 403)
    assert.equal((await send('/v1/assigned-tasks', { requestId: command.requestId, result }, {
      Authorization: `Bearer ${token}`
    })).status, 403)
    assert.equal((await send('/v1/assigned-tasks', { requestId: 'other-request', result: { tasks: 'nope' } }, extensionHeaders)).status, 400)
    assert.equal((await send('/v1/assigned-tasks', { requestId: 'other-request', result }, extensionHeaders)).status, 404)

    const posted = await send('/v1/assigned-tasks', { requestId: command.requestId, result }, extensionHeaders)
    assert.equal(posted.status, 200)
    assert.deepEqual(await posted.json(), { received: true })
    const listResponse = await listRead
    assert.equal(listResponse.status, 200)
    assert.deepEqual(await listResponse.json(), result)
    assert.deepEqual(await store.listSnapshots(), [])

    // No host anywhere: the extension answers INVALID_TARGET, which the bridge reports as 400
    const noHostRead = send('/v1/list-assigned-tasks', {}, adminHeaders)
    const noHostCommand = await nextCommand()
    assert.deepEqual(noHostCommand, { type: 'list-assigned-tasks', requestId: noHostCommand.requestId })
    ws.send(JSON.stringify({
      type: 'assigned-tasks-error', requestId: noHostCommand.requestId,
      error: 'No monday account to read', code: 'INVALID_TARGET'
    }))
    const noHostResponse = await noHostRead
    assert.equal(noHostResponse.status, 400)
    assert.deepEqual(await noHostResponse.json(), { error: 'No monday account to read' })

    // Any other extension failure is a 502 carrying its message
    const failingRead = send('/v1/list-assigned-tasks', { accountHost: 'team.monday.com' }, adminHeaders)
    const failingCommand = await nextCommand()
    ws.send(JSON.stringify({ type: 'assigned-tasks-error', requestId: failingCommand.requestId, error: 'monday API: boom' }))
    const failingResponse = await failingRead
    assert.equal(failingResponse.status, 502)
    assert.deepEqual(await failingResponse.json(), { error: 'monday API: boom' })

    // An extension that cannot filter boards is never asked to: the owner must reload it first
    const pickerResponse = await send('/v1/list-assigned-tasks', { boardsOnly: true }, adminHeaders)
    assert.equal(pickerResponse.status, 502)
    assert.match(((await pickerResponse.json()) as { error: string }).error, /EXTENSION_UPDATE_REQUIRED: .*choose a board/)

    // Without accountHost the latest snapshot's host is offered as the last resort
    const snapshot: TaskSnapshot = {
      sourceUrl: 'https://cached.monday.com/boards/1/pulses/2',
      accountHost: 'cached.monday.com', boardId: '1', itemId: '2',
      title: 'Cached task', fields: {}, updates: [], attachments: [],
      capturedAt: new Date().toISOString(), captureReason: 'mcp', complete: true, warnings: []
    }
    await store.saveSnapshot('cached-capture', snapshot, [])
    const cachedRead = send('/v1/list-assigned-tasks', {}, adminHeaders)
    const cachedCommand = await nextCommand()
    assert.deepEqual(cachedCommand, {
      type: 'list-assigned-tasks', requestId: cachedCommand.requestId, cachedHost: 'cached.monday.com'
    })
    const cachedResult = assignedTasks('cached.monday.com')
    assert.equal((await send('/v1/assigned-tasks', { requestId: cachedCommand.requestId, result: cachedResult }, extensionHeaders)).status, 200)
    assert.deepEqual(await (await cachedRead).json(), cachedResult)
    assert.equal((await store.listSnapshots()).length, 1)

    // MCP tool over stdio against the running bridge
    client = new Client({ name: 'monday-bridge-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [resolve('node_modules/tsx/dist/cli.mjs'), 'bridge/mcp.ts'],
      cwd: process.cwd(),
      env: { ...process.env, MONDAY_BRIDGE_DATA_DIR: dataDir, MONDAY_BRIDGE_PORT: String(port) }
    }))
    const tools = await client.listTools()
    assert.ok(tools.tools.some(tool => tool.name === 'monday_list_assigned_tasks'))

    const toolCall = client.callTool({ name: 'monday_list_assigned_tasks', arguments: { accountHost: 'team.monday.com' } })
    const toolCommand = await nextCommand()
    assert.deepEqual(toolCommand, {
      type: 'list-assigned-tasks', requestId: toolCommand.requestId,
      accountHost: 'team.monday.com', cachedHost: 'cached.monday.com'
    })
    assert.equal((await send('/v1/assigned-tasks', { requestId: toolCommand.requestId, result }, extensionHeaders)).status, 200)
    const listed = await toolCall
    assert.equal(listed.isError, undefined)
    assert.deepEqual(toolText(listed.content), result)

    const invalidCall = client.callTool({ name: 'monday_list_assigned_tasks', arguments: {} })
    const invalidCommand = await nextCommand()
    ws.send(JSON.stringify({
      type: 'assigned-tasks-error', requestId: invalidCommand.requestId,
      error: 'No monday account to read', code: 'INVALID_TARGET'
    }))
    const invalid = await invalidCall
    assert.equal(invalid.isError, true)
    assert.deepEqual(toolText(invalid.content), { error: 'INVALID_TARGET', message: 'No monday account to read' })

    const failingCall = client.callTool({ name: 'monday_list_assigned_tasks', arguments: { accountHost: 'team.monday.com' } })
    const failingToolCommand = await nextCommand()
    ws.send(JSON.stringify({ type: 'assigned-tasks-error', requestId: failingToolCommand.requestId, error: 'monday API: boom' }))
    const failing = await failingCall
    assert.equal(failing.isError, true)
    assert.deepEqual(toolText(failing.content), { error: 'monday API: boom', message: 'Failed to list assigned tasks' })

    const closed = new Promise<void>(resolve => ws!.once('close', () => resolve()))
    ws.close()
    await closed
    const offline = await client.callTool({ name: 'monday_list_assigned_tasks', arguments: { accountHost: 'team.monday.com' } })
    assert.equal(offline.isError, true)
    assert.equal((toolText(offline.content) as { error: string }).error, 'BROWSER_OFFLINE')
  } finally {
    await client?.close()
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

