import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Store } from '../bridge/store.js'
import type { TaskSnapshot } from '../shared/types.js'

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9H8xkAAAAASUVORK5CYII='

function snapshot(imageId: string): TaskSnapshot {
  return {
    sourceUrl: 'https://team.monday.com/boards/123/pulses/456',
    accountHost: 'team.monday.com',
    boardId: '123', itemId: '456', title: 'Example task', fields: {},
    updates: [],
    attachments: [{ id: imageId, name: 'image.png', mimeType: 'image/png', status: 'ready' }],
    capturedAt: new Date().toISOString(), captureReason: 'mcp', complete: true, warnings: []
  }
}

test('snapshot keeps original image bytes and never uses an image ID as a filesystem path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monday-bridge-test-'))
  try {
    const store = new Store(dir)
    await store.init()
    await store.saveSnapshot('request-1', snapshot('image-1'), [{
      id: 'image-1', name: 'image.png', mimeType: 'image/png', dataBase64: pngBase64
    }])
    const latest = await store.getLatestSnapshot()
    assert.equal(latest?.snapshot.title, 'Example task')
    assert.deepEqual(await store.getImageBytes('image-1'), Buffer.from(pngBase64, 'base64'))

    await assert.rejects(store.saveSnapshot('request-2', snapshot('../escape'), [{
      id: '../escape', name: 'image.png', mimeType: 'image/png', dataBase64: pngBase64
    }]))
    assert.equal((await readdir(join(dir, 'images'))).some(name => name === 'escape'), false)
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    await rm(dir, { recursive: true, force: true })
  }
})
