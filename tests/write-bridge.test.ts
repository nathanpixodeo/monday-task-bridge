import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'
import type { BridgeToExtensionMessage } from '../shared/types.js'

const extensionOrigin = `chrome-extension://${'d'.repeat(32)}`

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

test('the bridge relays an agent write only while "Allow writing" is on, and the answer back', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-agent-write-'))
  const previousDir = process.env.MONDAY_BRIDGE_DATA_DIR
  const previousPort = process.env.MONDAY_BRIDGE_PORT
  process.env.MONDAY_BRIDGE_DATA_DIR = dataDir
  const port = await freePort()
  process.env.MONDAY_BRIDGE_PORT = String(port)

  const { startServer, closeServer, store } = await import('../bridge/server.js')
  const server = await startServer()
  const base = `http://127.0.0.1:${port}`
  const sockets: WebSocket[] = []

  try {
    const send = (body: unknown, headers: Record<string, string>) => fetch(`${base}/v1/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    const health = async () => (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>
    const adminHeaders = { 'X-Bridge-Admin-Token': await store.getAdminToken() }
    const token = await store.rotateBridgeToken()

    // Connects an extension announcing the capabilities and switch given, and waits for its hello-ack.
    async function connect(capabilities: string[], writeEnabled?: boolean) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: extensionOrigin })
      sockets.push(ws)
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
      })
      const nextCommand = () => new Promise<BridgeToExtensionMessage & { requestId: string }>((resolve, reject) => {
        ws.once('message', data => {
          try { resolve(JSON.parse(data.toString())) } catch (error) { reject(error) }
        })
      })
      const ack = nextCommand()
      ws.send(JSON.stringify({ type: 'hello', token, capabilities, writeEnabled }))
      assert.equal((await ack).type, 'hello-ack')
      return { ws, nextCommand }
    }

    const update = { op: 'update-item', accountHost: 'team.monday.com', boardId: '123', itemId: '456', columns: { Status: 'Done', Tags: { add: ['urgent'] } } }

    // An extension from before agent writes is asked to reload, and nothing reaches it
    await connect(['assignedTasks', 'boardFilter', 'writeBack'])
    const old = await send(update, adminHeaders)
    assert.equal(old.status, 502)
    assert.match((await old.json() as { error: string }).error, /^EXTENSION_UPDATE_REQUIRED/)
    assert.equal((await health()).writeSupported, false)

    // With the switch off, the bridge refuses before the extension is asked
    const extension = await connect(['assignedTasks', 'boardFilter', 'writeBack', 'write'], false)
    assert.deepEqual([(await health()).writeSupported, (await health()).writeEnabled], [true, false])
    const off = await send(update, adminHeaders)
    assert.equal(off.status, 403)
    assert.match((await off.json() as { error: string }).error, /^WRITE_DISABLED: .*Allow writing/)

    // Only the MCP side may ask, and only for a write the bridge can check
    assert.equal((await send(update, {})).status, 403)
    for (const bad of [
      { ...update, op: 'delete-item' },
      { ...update, accountHost: 'www.monday.com' },
      { ...update, itemId: '45a' },
      { ...update, columns: {} },
      { ...update, columns: { Status: { label: 'Done' } } },
      { ...update, extra: true },
      { op: 'add-update', boardId: '123', itemId: '456', body: '  ' },
      { op: 'add-update', boardId: '123', itemId: '456', body: 'Hi', mentions: ['  '] },
      { op: 'create-item', boardId: '123', name: 'x', parentItemId: '456', group: 'Done' },
      { op: 'move-item', boardId: '123', itemId: '456' }
    ]) {
      assert.equal((await send(bad, adminHeaders)).status, 400, JSON.stringify(bad))
    }

    // The popup switches writing on
    extension.ws.send(JSON.stringify({ type: 'write-access', enabled: true }))
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await health()).writeEnabled, true)

    const written = send(update, adminHeaders)
    const command = await extension.nextCommand()
    assert.deepEqual(command, { type: 'write', requestId: command.requestId, ...update })
    const result = { op: 'update-item', accountHost: 'team.monday.com', boardId: '123', itemId: '456', columnsSet: ['Status', 'Tags'] }
    extension.ws.send(JSON.stringify({ type: 'write-result', requestId: command.requestId, result }))
    const response = await written
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), result)

    // An item the account cannot write to, a failed write, an answer the bridge cannot pass on, and a switch turned
    // off before the bridge heard of it
    for (const [answer, status, error] of [
      [{ error: 'monday item 456 was not found', code: 'INVALID_TARGET' }, 400, 'monday item 456 was not found'],
      [{ error: 'monday API: HTTP 500' }, 502, 'monday API: HTTP 500'],
      [{ result: { ...result, itemId: 'abc' } }, 502, 'Invalid write result'],
      [{ error: 'Writing is off.', code: 'WRITE_DISABLED' }, 403, /^WRITE_DISABLED: /]
    ] as const) {
      const pending = send(update, adminHeaders)
      const next = await extension.nextCommand()
      extension.ws.send(JSON.stringify({ type: 'write-result', requestId: next.requestId, ...answer }))
      const res = await pending
      assert.equal(res.status, status)
      const text = (await res.json() as { error: string }).error
      if (typeof error === 'string') assert.equal(text, error)
      else assert.match(text, error)
    }
    // The extension's refusal also turned the bridge's view of the switch off
    assert.equal((await health()).writeEnabled, false)
    assert.equal((await send(update, adminHeaders)).status, 403)
  } finally {
    for (const ws of sockets) ws.close()
    await closeServer(server)
    if (previousDir === undefined) delete process.env.MONDAY_BRIDGE_DATA_DIR
    else process.env.MONDAY_BRIDGE_DATA_DIR = previousDir
    if (previousPort === undefined) delete process.env.MONDAY_BRIDGE_PORT
    else process.env.MONDAY_BRIDGE_PORT = previousPort
  }
})
