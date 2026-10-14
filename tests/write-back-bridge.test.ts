import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'
import type { BridgeToExtensionMessage } from '../shared/types.js'

const extensionOrigin = `chrome-extension://${'c'.repeat(32)}`

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

test('the bridge relays a write-back to an extension that can write, and its answer back', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-write-'))
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
    const send = (body: unknown, headers: Record<string, string>) => fetch(`${base}/v1/write-back`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    const adminHeaders = { 'X-Bridge-Admin-Token': await store.getAdminToken() }
    const token = await store.rotateBridgeToken()

    // Connects an extension announcing the capabilities given, and waits for its hello-ack.
    async function connect(capabilities: string[]) {
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
      ws.send(JSON.stringify({ type: 'hello', token, capabilities }))
      assert.equal((await ack).type, 'hello-ack')
      return { ws, nextCommand }
    }

    const body = { accountHost: 'team.monday.com', boardId: '123', itemId: '456', comment: 'Done in Nexkit Hub: Fix the login' }

    // An extension from before write-back is asked to reload, and nothing reaches it
    await connect(['assignedTasks', 'boardFilter'])
    const old = await send(body, adminHeaders)
    assert.equal(old.status, 502)
    assert.match((await old.json() as { error: string }).error, /^EXTENSION_UPDATE_REQUIRED/)
    assert.equal((await (await fetch(`${base}/health`)).json() as Record<string, unknown>).writeBackSupported, false)

    const extension = await connect(['assignedTasks', 'boardFilter', 'writeBack'])
    assert.equal((await (await fetch(`${base}/health`)).json() as Record<string, unknown>).writeBackSupported, true)

    // Only the MCP side may ask, and only for a write the bridge can check
    assert.equal((await send(body, {})).status, 403)
    for (const bad of [
      { ...body, accountHost: 'www.monday.com' },
      { ...body, accountHost: 'evil.example.com' },
      { ...body, boardId: '12a' },
      { ...body, comment: '   ' },
      { ...body, statusLabel: '' },
      { ...body, extra: true }
    ]) {
      assert.equal((await send(bad, adminHeaders)).status, 400, JSON.stringify(bad))
    }

    // A write the extension made
    const written = send({ ...body, statusLabel: 'Done' }, adminHeaders)
    const command = await extension.nextCommand()
    assert.deepEqual(command, { type: 'write-back', requestId: command.requestId, ...body, statusLabel: 'Done' })
    extension.ws.send(JSON.stringify({ type: 'write-back-result', requestId: command.requestId, result: { updateId: '901', statusSet: true } }))
    const response = await written
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { updateId: '901', statusSet: true })

    // An item the account cannot write to, a failed write, and an answer the bridge cannot pass on
    for (const [answer, status, error] of [
      [{ error: 'monday item 456 was not found', code: 'INVALID_TARGET' }, 400, 'monday item 456 was not found'],
      [{ error: 'monday API: HTTP 500' }, 502, 'monday API: HTTP 500'],
      [{ result: { updateId: 'abc', statusSet: true } }, 502, 'Invalid write-back result']
    ] as const) {
      const pending = send(body, adminHeaders)
      const next = await extension.nextCommand()
      extension.ws.send(JSON.stringify({ type: 'write-back-result', requestId: next.requestId, ...answer }))
      const res = await pending
      assert.equal(res.status, status)
      assert.equal((await res.json() as { error: string }).error, error)
    }
  } finally {
    for (const ws of sockets) ws.close()
    await closeServer(server)
    if (previousDir === undefined) delete process.env.MONDAY_BRIDGE_DATA_DIR
    else process.env.MONDAY_BRIDGE_DATA_DIR = previousDir
    if (previousPort === undefined) delete process.env.MONDAY_BRIDGE_PORT
    else process.env.MONDAY_BRIDGE_PORT = previousPort
  }
})
