/**
 * bridge/pair-cli.ts – CLI tool for approving pairing requests.
 *
 * Usage:  tsx bridge/pair-cli.ts <6-digit-code>
 *
 * Reads the admin token from the local data directory and calls
 * POST /v1/pair/approve with the code.
 */

import { Store } from './store.js'

const BRIDGE_BASE = `http://127.0.0.1:${process.env.MONDAY_BRIDGE_PORT ?? '3457'}`

async function main(): Promise<void> {
  const code = process.argv[2]
  if (!code || !/^\d{6}$/.test(code)) {
    process.stderr.write('Usage: pair-cli <6-digit-code>\n')
    process.stderr.write('  Approve a pending extension pairing request.\n\n')
    process.exit(1)
  }

  const store = new Store()
  await store.init()
  const adminToken = await store.getAdminToken()

  process.stderr.write(`[pair-cli] Data dir: ${store.dataDir}\n`)
  process.stderr.write(`[pair-cli] Approving code: ${code}\n`)

  try {
    const res = await fetch(`${BRIDGE_BASE}/v1/pair/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Admin-Token': adminToken,
      },
      body: JSON.stringify({ code }),
    })

    const body = await res.json()

    if (res.ok) {
      process.stderr.write(`[pair-cli] ✓ Pairing approved! pairId=${(body as { pairId?: string }).pairId}\n`)
      process.stderr.write('[pair-cli] The extension should now be authenticated.\n')
    } else {
      process.stderr.write(`[pair-cli] ✗ Failed: ${JSON.stringify(body)}\n`)
      process.exit(1)
    }
  } catch (err: unknown) {
    process.stderr.write(`[pair-cli] ✗ Cannot connect to bridge server at ${BRIDGE_BASE}\n`)
    process.stderr.write(`[pair-cli]   Make sure the server is running (npm run bridge)\n`)
    if (err instanceof Error) {
      process.stderr.write(`[pair-cli]   ${err.message}\n`)
    }
    process.exit(1)
  }
}

main()
