/**
 * bridge/cli.ts – the `monday-bridge` command, runnable from any folder once installed globally.
 *
 *   monday-bridge start | stop | run | status | pair <code> | approval auto|manual|status | help
 *
 * Each command runs the matching script next to this one (start-cli, pair-cli, approval-cli, server),
 * so `monday-bridge pair 123456` does exactly what `npm run pair -- 123456` does in the checkout.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { resolveDataDir } from './store.js'

const BRIDGE_BASE = `http://127.0.0.1:${process.env.MONDAY_BRIDGE_PORT ?? '3457'}`
const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR = join(HERE, '..', '..')

const USAGE = `Usage: monday-bridge <command>

  start                       Start the bridge in the background (agents also start it on their own)
  stop                        Stop the running bridge
  run                         Run the bridge in this window; Ctrl+C stops it
  status                      Show the bridge, pairing and extension state, and the folders in use
  pair <code>                 Approve the 6-digit code shown in the extension popup
  approval auto|manual|status Read monday without a yes/no prompt each time (auto), or ask (manual)
  help                        Show this help
`

interface Health {
  status?: string
  paired?: boolean
  extensionConnected?: boolean
  build?: string
  pid?: number
}

async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${BRIDGE_BASE}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok ? ((await res.json()) as Health) : null
  } catch {
    return null
  }
}

/** Runs a script next to this one in this window and returns its exit code. */
function runScript(script: string, args: string[] = []): number {
  const result = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' })
  return result.status ?? 1
}

/**
 * On Windows a process started by node inherits this window's output handles, so the long-running bridge would keep
 * them open and a caller that reads this command's output (an agent, a script) would wait for the bridge to exit.
 * PowerShell's Start-Process passes no handles on, so start-cli, and the bridge it starts, run apart from them.
 */
async function start(): Promise<number> {
  if (process.platform !== 'win32') return runScript('start-cli.js')
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`
  const script = [
    `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(`"${join(HERE, 'start-cli.js')}"`)} -WindowStyle Hidden -PassThru`,
    '$null = $p.Handle',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'ignore' })
  const state = await health()
  if (!state) {
    console.error(`The bridge did not start. Its log is ${join(resolveDataDir(), 'bridge.log')}`)
    return 1
  }
  console.log(`Bridge running at ${BRIDGE_BASE} (pid ${state.pid}).`)
  return 0
}

async function stop(): Promise<number> {
  const state = await health()
  if (!state?.pid) {
    console.log(`The bridge is not running at ${BRIDGE_BASE}.`)
    return 0
  }
  try {
    process.kill(state.pid)
  } catch (err: unknown) {
    console.error(`Could not stop the bridge (pid ${state.pid}): ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
  for (let i = 0; i < 25 && (await health()); i++) await sleep(200)
  console.log(`Bridge stopped (pid ${state.pid}). The next agent call starts it again.`)
  return 0
}

async function run(): Promise<number> {
  const state = await health()
  if (state) {
    console.error(`The bridge is already running (pid ${state.pid}). Stop it first with: monday-bridge stop`)
    return 1
  }
  return runScript('server.js')
}

async function status(): Promise<number> {
  const state = await health()
  const dataDir = resolveDataDir()
  if (state) {
    console.log(`Bridge:     running at ${BRIDGE_BASE} (pid ${state.pid}, build ${state.build})`)
    console.log(`Paired:     ${state.paired ? 'yes' : 'no (open the extension popup and tap the power button)'}`)
    console.log(`Connected:  ${state.extensionConnected ? 'yes' : 'no (Chrome closed, or the power button is off)'}`)
  } else {
    console.log(`Bridge:     not running at ${BRIDGE_BASE} (start it with: monday-bridge start)`)
  }
  console.log(`Install:    ${INSTALL_DIR}`)
  console.log(`Extension:  ${join(INSTALL_DIR, 'dist', 'extension')} (Load unpacked in chrome://extensions)`)
  console.log(`Data:       ${dataDir}`)
  console.log(`Log:        ${join(dataDir, 'bridge.log')}`)
  return 0
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'start':
      return start()
    case 'stop':
      return stop()
    case 'run':
      return run()
    case 'status':
      return status()
    case 'pair':
      return runScript('pair-cli.js', args)
    case 'approval':
      return runScript('approval-cli.js', args)
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return 0
    default:
      console.error(`Unknown command: ${command}\n`)
      console.error(USAGE)
      return 1
  }
}

process.exit(await main())
