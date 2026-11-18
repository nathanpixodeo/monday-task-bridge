import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'
import type { BridgeToExtensionMessage, StagedFile } from '../shared/types.js'
import { stagedCount } from '../bridge/uploads.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9H8xkAAAAASUVORK5CYII=', 'base64')

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
    const editUpdate = { op: 'edit-update', accountHost: 'team.monday.com', boardId: '123', itemId: '456', updateId: '77', body: 'Fixed typo', mentions: ['me'] }
    const deleteUpdate = { op: 'delete-update', accountHost: 'team.monday.com', boardId: '123', itemId: '456', updateId: '77' }

    // An extension from before agent writes is asked to reload, and nothing reaches it
    await connect(['assignedTasks', 'boardFilter', 'writeBack'])
    const old = await send(update, adminHeaders)
    assert.equal(old.status, 502)
    assert.match((await old.json() as { error: string }).error, /^EXTENSION_UPDATE_REQUIRED/)
    assert.equal((await health()).writeSupported, false)

    // An extension that writes but cannot edit or delete updates is asked to reload for those two only
    await connect(['assignedTasks', 'boardFilter', 'writeBack', 'write'], false)
    for (const body of [editUpdate, deleteUpdate]) {
      const res = await send(body, adminHeaders)
      assert.equal(res.status, 502)
      assert.match((await res.json() as { error: string }).error, /^EXTENSION_UPDATE_REQUIRED: .*edit or delete monday updates/)
    }
    assert.equal((await send(update, adminHeaders)).status, 403)

    // With the switch off, the bridge refuses before the extension is asked
    const extension = await connect(['assignedTasks', 'boardFilter', 'writeBack', 'write', 'updateEdits'], false)
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
      { op: 'add-update', boardId: '123', itemId: '456', body: 'Hi', files: ['  '] },
      { op: 'add-update', boardId: '123', itemId: '456', body: 'Hi', files: Array(11).fill('/tmp/a.png') },
      { op: 'add-update', boardId: '123', itemId: '456', body: 'Hi', attachments: [] },
      { op: 'create-item', boardId: '123', name: 'x', parentItemId: '456', group: 'Done' },
      { op: 'move-item', boardId: '123', itemId: '456' },
      { ...editUpdate, body: '  ' },
      { ...editUpdate, updateId: '7a' },
      { ...editUpdate, replyToUpdateId: '78' },
      { ...deleteUpdate, body: 'x' },
      { op: 'delete-update', boardId: '123', itemId: '456' }
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

    // Editing and deleting an update go the same way; a delete hands back the text it removed
    for (const [body, answer] of [
      [editUpdate, { op: 'edit-update', accountHost: 'team.monday.com', boardId: '123', itemId: '456', updateId: '77', mentioned: ['Me'] }],
      [deleteUpdate, { op: 'delete-update', accountHost: 'team.monday.com', boardId: '123', itemId: '456', updateId: '77', deletedBody: 'Old text' }]
    ] as const) {
      const pending = send(body, adminHeaders)
      const next = await extension.nextCommand()
      assert.deepEqual(next, { type: 'write', requestId: next.requestId, ...body })
      extension.ws.send(JSON.stringify({ type: 'write-result', requestId: next.requestId, result: answer }))
      const res = await pending
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), answer)
    }

    // The agent's name comes along for the popup's activity log; an odd one is dropped
    for (const [header, agent] of [['codex-mcp-client', 'codex-mcp-client'], ['bad	name', undefined]] as const) {
      const named = send(update, { ...adminHeaders, 'X-Bridge-Agent': header })
      const next = await extension.nextCommand()
      assert.equal((next as { agent?: string }).agent, agent)
      extension.ws.send(JSON.stringify({ type: 'write-result', requestId: next.requestId, result }))
      assert.equal((await named).status, 200)
    }

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

    // Images: the bridge reads them, and the extension gets their ids only, never a path or the bytes
    const frame = join(dataDir, 'frame.png')
    const secret = join(dataDir, 'secret.png')
    await writeFile(frame, PNG)
    await writeFile(secret, 'API_KEY=abc')
    const withImages = { op: 'add-update', accountHost: 'team.monday.com', boardId: '123', itemId: '456', body: 'Design', files: [frame] }

    // An extension that cannot attach images is asked to reload, before it could post a bare update
    const noFiles = await send(withImages, adminHeaders)
    assert.equal(noFiles.status, 502)
    assert.match((await noFiles.json() as { error: string }).error, /^EXTENSION_UPDATE_REQUIRED: .*attach images/)
    assert.equal(stagedCount(), 0)

    const imaging = await connect(['assignedTasks', 'boardFilter', 'writeBack', 'write', 'updateEdits', 'updateFiles'], true)
    // A file that cannot go up stops the write before the extension hears of it
    for (const [files, reason] of [
      [['frame.png'], /is not an absolute path/],
      [[join(dataDir, 'missing.png')], /^No file at /],
      [[frame, secret], /secret\.png is not a PNG, JPEG, GIF or WebP image/]
    ] as const) {
      const res = await send({ ...withImages, files }, adminHeaders)
      assert.equal(res.status, 400)
      assert.match((await res.json() as { error: string }).error, reason)
    }
    assert.equal(stagedCount(), 0)

    const posting = send(withImages, adminHeaders)
    // The first command the extension gets is this write: none of the refused ones reached it
    const imageWrite = await imaging.nextCommand() as unknown as { requestId: string; attachments?: StagedFile[] }
    const { attachments, ...sent } = imageWrite
    assert.deepEqual(sent, { type: 'write', requestId: imageWrite.requestId, op: 'add-update', accountHost: 'team.monday.com', boardId: '123', itemId: '456', body: 'Design' })
    assert.equal(attachments?.length, 1)
    assert.deepEqual({ ...attachments[0], uploadId: '' }, { uploadId: '', name: 'frame.png', mimeType: 'image/png', size: PNG.length })

    // The extension fetches the bytes with its token, from its own origin only
    const held = `${base}/v1/uploads/${attachments[0].uploadId}`
    const extensionHeaders = { Origin: extensionOrigin, Authorization: `Bearer ${token}` }
    assert.equal((await fetch(held, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 403)
    assert.equal((await fetch(held, { method: 'POST', headers: { Origin: extensionOrigin } })).status, 401)
    assert.equal((await fetch(held, { method: 'POST', headers: { ...extensionHeaders, Authorization: 'Bearer wrong' } })).status, 403)
    assert.equal((await fetch(`${base}/v1/uploads/${'0'.repeat(32)}`, { method: 'POST', headers: extensionHeaders })).status, 404)
    const bytes = await fetch(held, { method: 'POST', headers: extensionHeaders })
    assert.equal(bytes.status, 200)
    assert.equal(bytes.headers.get('content-type'), 'image/png')
    assert.ok(Buffer.from(await bytes.arrayBuffer()).equals(PNG))

    const attached = { op: 'add-update', accountHost: 'team.monday.com', boardId: '123', itemId: '456', updateId: '903', files: ['frame.png'] }
    imaging.ws.send(JSON.stringify({ type: 'write-result', requestId: imageWrite.requestId, result: attached }))
    const posted = await posting
    assert.equal(posted.status, 200)
    assert.deepEqual(await posted.json(), attached)
    // The bytes go once the write has settled
    assert.equal(stagedCount(), 0)
    assert.equal((await fetch(held, { method: 'POST', headers: extensionHeaders })).status, 404)

    // A failed upload releases them too
    const failing = send(withImages, adminHeaders)
    const again = await imaging.nextCommand()
    imaging.ws.send(JSON.stringify({ type: 'write-result', requestId: again.requestId, error: 'Added update 904, but could not attach frame.png: monday API: HTTP 413' }))
    const failed = await failing
    assert.equal(failed.status, 502)
    assert.match((await failed.json() as { error: string }).error, /^Added update 904/)
    assert.equal(stagedCount(), 0)
  } finally {
    for (const ws of sockets) ws.close()
    await closeServer(server)
    if (previousDir === undefined) delete process.env.MONDAY_BRIDGE_DATA_DIR
    else process.env.MONDAY_BRIDGE_DATA_DIR = previousDir
    if (previousPort === undefined) delete process.env.MONDAY_BRIDGE_PORT
    else process.env.MONDAY_BRIDGE_PORT = previousPort
  }
})
