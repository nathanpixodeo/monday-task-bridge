import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'

const extensionOrigin = `chrome-extension://${'e'.repeat(32)}`

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

test('a bridge that just started waits for the extension, then fails at once once it has been connected', { timeout: 30_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-grace-'))
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
    const adminHeaders = { 'Content-Type': 'application/json', 'X-Bridge-Admin-Token': await store.getAdminToken() }
    const readOpenTask = () => fetch(`${base}/v1/read-open-task`, { method: 'POST', headers: adminHeaders, body: '{}' })
    const token = await store.rotateBridgeToken()

    // No extension yet: the agent's first read waits for it instead of failing with BROWSER_OFFLINE
    const firstRead = readOpenTask()
    await new Promise(resolve => setTimeout(resolve, 300))
    ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: extensionOrigin })
    // The capture command follows the hello-ack at once, so every message is queued as it arrives
    type Message = { type: string; requestId?: string }
    const messages: Message[] = []
    const waiting: Array<(message: Message) => void> = []
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Message
      const resolve = waiting.shift()
      if (resolve) resolve(message)
      else messages.push(message)
    })
    const next = () => new Promise<Message>((resolve) => {
      const queued = messages.shift()
      if (queued) resolve(queued)
      else waiting.push(resolve)
    })
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => resolve())
      ws!.once('error', reject)
    })
    const ack = next()
    ws.send(JSON.stringify({ type: 'hello', token, capabilities: ['assignedTasks', 'boardFilter', 'writeBack', 'write'] }))
    assert.equal((await ack).type, 'hello-ack')
    const command = await next()
    assert.equal(command.type, 'capture')
    ws.send(JSON.stringify({ type: 'capture-result', requestId: command.requestId, error: 'No monday task tab found' }))
    const first = await firstRead
    assert.equal(first.status, 502)
    assert.equal((await first.json() as { error: string }).error, 'No monday task tab found')

    // Once an extension has connected, a missing one means Chrome is closed: no wait
    const closed = new Promise<void>(resolve => ws!.once('close', () => resolve()))
    ws.close()
    await closed
    await new Promise(resolve => setTimeout(resolve, 100))
    const started = Date.now()
    const offline = await readOpenTask()
    assert.equal(offline.status, 502)
    assert.equal((await offline.json() as { error: string }).error, 'BROWSER_OFFLINE')
    assert.ok(Date.now() - started < 2000)
  } finally {
    ws?.terminate()
    await closeServer(server)
    if (previousDir === undefined) delete process.env.MONDAY_BRIDGE_DATA_DIR
    else process.env.MONDAY_BRIDGE_DATA_DIR = previousDir
    if (previousPort === undefined) delete process.env.MONDAY_BRIDGE_PORT
    else process.env.MONDAY_BRIDGE_PORT = previousPort
  }
})
