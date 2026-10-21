/**
 * bridge/start-cli.ts – start the bridge in the background unless it is already running.
 *
 * Usage:  node dist/bridge/start-cli.js
 *
 * Same start as the MCP server's: detached, no window, log in <dataDir>/bridge.log.
 * The installer runs it so the extension finds a bridge to pair with.
 */

import { ensureBridge } from './autostart.js'
import { Store } from './store.js'

const BRIDGE_BASE = `http://127.0.0.1:${process.env.MONDAY_BRIDGE_PORT ?? '3457'}`

try {
  const store = new Store()
  const { started } = await ensureBridge({ base: BRIDGE_BASE, dataDir: store.dataDir })
  process.stderr.write(`[start-cli] Bridge ${started ? 'started' : 'already running'} at ${BRIDGE_BASE}\n`)
} catch (err: unknown) {
  process.stderr.write(`[start-cli] ✗ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
