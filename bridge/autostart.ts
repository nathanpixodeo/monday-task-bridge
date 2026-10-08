/**
 * bridge/autostart.ts – start the HTTP bridge from the MCP process when it is not running.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface EnsureBridgeOptions {
  /** Bridge origin, e.g. http://127.0.0.1:3457 */
  base: string
  /** Directory that receives bridge.log */
  dataDir: string
  /** Executable override, for tests */
  command?: string
  /** Arguments override, for tests */
  args?: string[]
}

const PROBE_TIMEOUT_MS = 1000
const START_TIMEOUT_MS = 5000
const POLL_INTERVAL_MS = 200

async function isHealthy(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    // Only the status matters; release the connection instead of waiting for GC
    await res.body?.cancel()
    return res.ok
  } catch {
    // Connection refused or timed out: nothing is serving the bridge port
    return false
  }
}

function defaultBridgeArgs(): string[] {
  // Built layout: the esbuild output keeps server.js next to the bundled MCP entry
  const built = fileURLToPath(new URL('./server.js', import.meta.url))
  if (existsSync(built)) return [built]
  // Source layout (npm run mcp, tests): only server.ts exists, so run it through the tsx loader.
  // The loader is registered in-process rather than via the tsx CLI, because the CLI spawns a
  // second node process and on Windows that one opens a visible console (the detached parent has none).
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  return ['--import', tsxLoader, fileURLToPath(new URL('./server.ts', import.meta.url))]
}

export async function ensureBridge(opts: EnsureBridgeOptions): Promise<{ started: boolean; pid?: number }> {
  const { base, dataDir } = opts
  if (await isHealthy(base)) return { started: false }

  const command = opts.command ?? process.execPath
  const args = opts.args ?? defaultBridgeArgs()

  // The bridge is detached and has no terminal, so its stdout/stderr go to a file the user can read
  mkdirSync(dataDir, { recursive: true })
  const logPath = join(dataDir, 'bridge.log')
  const logFd = openSync(logPath, 'a')

  let child: ChildProcess
  try {
    // Detached so the bridge outlives this MCP process, which the agent may stop at any time.
    // env is shared so the bridge resolves the same MONDAY_BRIDGE_DATA_DIR / MONDAY_BRIDGE_PORT.
    child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
  } finally {
    // The child holds its own copy of the descriptor
    closeSync(logFd)
  }

  // A failed spawn (e.g. missing executable) is reported as an async 'error' event;
  // unhandled, it would take down the whole MCP process instead of failing one tool call.
  let spawnError: Error | undefined
  child.on('error', (err) => {
    spawnError = err
  })

  const deadline = Date.now() + START_TIMEOUT_MS
  while (!spawnError && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    if (await isHealthy(base)) return { started: true, pid: child.pid }
  }

  throw new Error(
    `BRIDGE_UNAVAILABLE: could not start the bridge on ${base}. Another program may hold the port; see ${logPath}`,
    spawnError ? { cause: spawnError } : undefined
  )
}
