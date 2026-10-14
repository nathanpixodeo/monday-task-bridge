import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { watchBuild } from '../bridge/buildWatch.js'

const INTERVAL = 15

async function withBuildFile(run: (file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-build-'))
  try {
    await run(join(dir, 'build-id.txt'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('keeps running while the build on disk is its own', async () => {
  await withBuildFile(async (file) => {
    await writeFile(file, 'build-a\n')
    const seen: string[] = []
    const watch = watchBuild({ file, own: 'build-a', intervalMs: INTERVAL, isIdle: () => true, onNewBuild: (id) => seen.push(id) })
    await sleep(INTERVAL * 6)
    watch.stop()
    assert.deepEqual(seen, [])
  })
})

test('steps aside for a newer build only once nothing waits for an answer, and only once', async () => {
  await withBuildFile(async (file) => {
    await writeFile(file, 'build-a')
    let idle = false
    const seen: string[] = []
    const watch = watchBuild({ file, own: 'build-a', intervalMs: INTERVAL, isIdle: () => idle, onNewBuild: (id) => seen.push(id) })

    await writeFile(file, 'build-b')
    await sleep(INTERVAL * 6)
    assert.deepEqual(seen, [], 'a request in flight keeps the old build')

    idle = true
    await sleep(INTERVAL * 6)
    watch.stop()
    assert.deepEqual(seen, ['build-b'])
  })
})

test('does nothing without a build id file, or when run from source', async () => {
  await withBuildFile(async (file) => {
    const seen: string[] = []
    const missing = watchBuild({ file, own: 'build-a', intervalMs: INTERVAL, isIdle: () => true, onNewBuild: (id) => seen.push(id) })
    await sleep(INTERVAL * 4)
    missing.stop()

    await writeFile(file, 'build-b')
    const fromSource = watchBuild({ file, own: 'dev', intervalMs: INTERVAL, isIdle: () => true, onNewBuild: (id) => seen.push(id) })
    await sleep(INTERVAL * 4)
    fromSource.stop()
    assert.deepEqual(seen, [])
  })
})
