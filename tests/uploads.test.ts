import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  imageMimeOf,
  MAX_UPLOAD_FILE_BYTES,
  releaseStaged,
  stagedCount,
  stagedFile,
  stageFiles,
  UploadError
} from '../bridge/uploads.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9H8xkAAAAASUVORK5CYII=', 'base64')

test('imageMimeOf knows PNG, JPEG, GIF and WebP by their first bytes, and nothing else', () => {
  assert.equal(imageMimeOf(PNG), 'image/png')
  assert.equal(imageMimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg')
  assert.equal(imageMimeOf(Buffer.from('GIF89a......')), 'image/gif')
  assert.equal(imageMimeOf(Buffer.from('GIF87a......')), 'image/gif')
  assert.equal(imageMimeOf(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ')), 'image/webp')
  // A WAV file is RIFF too
  assert.equal(imageMimeOf(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt ')), null)
  assert.equal(imageMimeOf(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----')), null)
  assert.equal(imageMimeOf(Buffer.from([0x89, 0x50])), null)
  assert.equal(imageMimeOf(Buffer.alloc(0)), null)
})

test('stageFiles holds images only, and holds nothing when one file cannot be attached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monday-bridge-uploads-'))
  try {
    const frame = join(dir, 'frame.png')
    const named = join(dir, 'secret.png')
    const big = join(dir, 'big.png')
    await writeFile(frame, PNG)
    // The name does not count: only the first bytes do
    await writeFile(named, 'API_KEY=abc')
    await writeFile(big, PNG)
    await truncate(big, MAX_UPLOAD_FILE_BYTES + 1)

    for (const [paths, reason] of [
      [['frame.png'], /is not an absolute path/],
      [[join(dir, 'missing.png')], /^No file at /],
      [[dir], /^No file at /],
      [[frame, named], /secret\.png is not a PNG, JPEG, GIF or WebP image/],
      [[big], /is larger than 20 MB/],
      [Array(11).fill(frame), /at most 10 files/]
    ] as const) {
      await assert.rejects(stageFiles([...paths]), (err: unknown) => err instanceof UploadError && reason.test(err.message))
    }
    assert.equal(stagedCount(), 0)

    const files = await stageFiles([frame, frame])
    assert.equal(files.length, 2)
    assert.notEqual(files[0].uploadId, files[1].uploadId)
    assert.match(files[0].uploadId, /^[a-f0-9]{32}$/)
    assert.deepEqual({ ...files[0], uploadId: '' }, { uploadId: '', name: 'frame.png', mimeType: 'image/png', size: PNG.length })
    const held = stagedFile(files[0].uploadId)
    assert.ok(held)
    assert.equal(held.mimeType, 'image/png')
    assert.ok(held.bytes.equals(PNG))

    releaseStaged(files)
    assert.equal(stagedFile(files[0].uploadId), null)
    assert.equal(stagedCount(), 0)
    assert.equal(stagedFile('0'.repeat(32)), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
