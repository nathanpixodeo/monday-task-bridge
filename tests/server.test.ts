import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import WebSocket from 'ws'
import type { CapturePayload, TaskSnapshot } from '../shared/types.js'

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9H8xkAAAAASUVORK5CYII='
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

function payload(requestId: string): CapturePayload {
  const snapshot: TaskSnapshot = {
    sourceUrl: 'https://team.monday.com/boards/123/pulses/456',
    accountHost: 'team.monday.com', boardId: '123', itemId: '456',
    title: 'Example task', fields: { Status: 'Working on it' }, updates: [],
    attachments: [{ id: 'image-1', name: 'image.png', mimeType: 'image/png', status: 'ready' }],
    capturedAt: new Date().toISOString(), captureReason: 'mcp', complete: true, warnings: []
  }
  return {
    requestId, snapshot,
    images: [{ id: 'image-1', name: 'image.png', mimeType: 'image/png', dataBase64: pngBase64 }]
  }
}

test('pairing, origin restrictions, original image storage and live capture work together', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-http-'))
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

    const malformedWs = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: extensionOrigin })
    await new Promise<void>((resolve, reject) => {
      malformedWs.once('open', () => resolve())
      malformedWs.once('error', reject)
    })
    malformedWs.send('null')
    await new Promise<void>(resolve => malformedWs.once('close', () => resolve()))
    assert.equal((await fetch(base + '/health')).status, 200)

    assert.equal((await send('/v1/pair/request', { secret: 'secret' }, {
      Origin: 'https://evil.example'
    })).status, 403)

    const pairResponse = await send('/v1/pair/request', { secret: 'long-random-secret' }, {
      Origin: extensionOrigin
    })
    assert.equal(pairResponse.status, 200)
    const pair = await pairResponse.json() as { pairId: string; code: string }
    assert.match(pair.code, /^\d{6}$/)

    const adminToken = await store.getAdminToken()
    assert.equal((await send('/v1/pair/approve', { code: pair.code }, {
      'X-Bridge-Admin-Token': adminToken
    })).status, 200)

    const poll = await fetch(base + `/v1/pair/${pair.pairId}`, {
      headers: { Origin: extensionOrigin, 'X-Pairing-Secret': 'long-random-secret' }
    })
    assert.equal(poll.status, 200)
    const { token } = await poll.json() as { token: string }
    assert.ok(token)
    assert.equal((await fetch(base + `/v1/pair/${pair.pairId}`, {
      headers: { Origin: extensionOrigin, 'X-Pairing-Secret': 'long-random-secret' }
    })).status, 404)

    const newOrigin = `chrome-extension://${'b'.repeat(32)}`
    assert.equal((await fetch(base + '/v1/pair/request', {
      method: 'OPTIONS', headers: { Origin: newOrigin }
    })).status, 204)
    const replacementResponse = await send('/v1/pair/request', { secret: 'replacement-secret' }, {
      Origin: newOrigin
    })
    assert.equal(replacementResponse.status, 200)
    const replacement = await replacementResponse.json() as { pairId: string; code: string }

    assert.equal((await send('/v1/snapshots', payload('bad-origin'), {
      Origin: `chrome-extension://${'b'.repeat(32)}`, Authorization: `Bearer ${token}`
    })).status, 403)
    assert.equal((await send('/v1/snapshots', payload('bad-token'), {
      Origin: extensionOrigin, Authorization: 'Bearer wrong'
    })).status, 403)

    ws = new WebSocket(`ws://127.0.0.1:${port}/v1/live`, { origin: extensionOrigin })
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => resolve())
      ws!.once('error', reject)
    })
    ws.send(JSON.stringify({ type: 'hello', token }))
    const ack = await new Promise<{ type: string }>((resolve, reject) => {
      ws!.once('message', data => {
        try { resolve(JSON.parse(data.toString())) } catch (error) { reject(error) }
      })
    })
    assert.equal(ack.type, 'hello-ack')

    const liveRead = send('/v1/read-open-task', {}, { 'X-Bridge-Admin-Token': adminToken })
    const command = await new Promise<{ type: string; requestId: string }>((resolve, reject) => {
      ws!.once('message', data => {
        try { resolve(JSON.parse(data.toString())) } catch (error) { reject(error) }
      })
    })
    assert.equal(command.type, 'capture')
    assert.equal((await send('/v1/snapshots', payload(command.requestId), {
      Origin: extensionOrigin, Authorization: `Bearer ${token}`
    })).status, 200)

    const result = await liveRead
    assert.equal(result.status, 200)
    const live = await result.json() as { snapshot: TaskSnapshot }
    assert.equal(live.snapshot.title, 'Example task')
    assert.deepEqual(await store.getImageBytes('image-1'), Buffer.from(pngBase64, 'base64'))

    const partial = payload('partial-capture')
    partial.images = []
    partial.snapshot.attachments = [{
      id: 'unavailable-1', name: 'missing.png', mimeType: 'image/png',
      status: 'unavailable', error: 'Original image unavailable'
    }]
    assert.equal((await send('/v1/snapshots', partial, {
      Origin: extensionOrigin, Authorization: `Bearer ${token}`
    })).status, 200)
    assert.equal((await store.getSnapshot('partial-capture'))?.snapshot.complete, false)

    assert.equal((await send('/v1/pair/approve', { code: replacement.code }, {
      'X-Bridge-Admin-Token': adminToken
    })).status, 200)
    const replacementPoll = await fetch(base + `/v1/pair/${replacement.pairId}`, {
      headers: { Origin: newOrigin, 'X-Pairing-Secret': 'replacement-secret' }
    })
    assert.equal(replacementPoll.status, 200)
    assert.equal((await replacementPoll.json() as { token: string }).token, token)
    assert.equal((await send('/v1/snapshots', payload('old-origin-after-repair'), {
      Origin: extensionOrigin, Authorization: `Bearer ${token}`
    })).status, 403)
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
