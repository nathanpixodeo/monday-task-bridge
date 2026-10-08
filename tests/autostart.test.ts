import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer as createNetServer } from 'node:net'
import { ensureBridge } from '../bridge/autostart.js'

async function freePort(): Promise<number> {
  const socket = createNetServer()
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  const address = socket.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => socket.close(() => resolve()))
  return address.port
}

async function waitUntilDown(base: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      await fetch(base + '/health', { signal: AbortSignal.timeout(500) })
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

test('ensureBridge starts a detached bridge when none is running and reuses it afterwards', { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'monday-bridge-autostart-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const previousDir = process.env.MONDAY_BRIDGE_DATA_DIR
  const previousPort = process.env.MONDAY_BRIDGE_PORT
  process.env.MONDAY_BRIDGE_DATA_DIR = dataDir
  process.env.MONDAY_BRIDGE_PORT = String(port)
  let pid: number | undefined

  try {
    const first = await ensureBridge({ base, dataDir })
    pid = first.pid
    assert.equal(first.started, true)
    assert.ok(typeof first.pid === 'number' && first.pid > 0)
    assert.equal((await fetch(base + '/health')).status, 200)

    const second = await ensureBridge({ base, dataDir })
    assert.equal(second.started, false)
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid)
      } catch {
        // Already gone, or not signalable on this platform
      }
      await waitUntilDown(base)
    }
    if (previousDir === undefined) delete process.env.MONDAY_BRIDGE_DATA_DIR
    else process.env.MONDAY_BRIDGE_DATA_DIR = previousDir
    if (previousPort === undefined) delete process.env.MONDAY_BRIDGE_PORT
    else process.env.MONDAY_BRIDGE_PORT = previousPort
    assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep))
    // On Windows the killed bridge can keep bridge.log locked for a moment after it stops answering
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
