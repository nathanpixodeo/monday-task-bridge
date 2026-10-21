/**
 * bridge/approval-cli.ts – choose whether agent CLIs ask before each monday read.
 *
 * Usage:  node dist/bridge/approval-cli.js auto|manual|status
 *
 *   auto    Claude Code, Codex and agy run the bridge's read tools without asking.
 *   manual  Removes those rules, so each CLI asks again (its default).
 *   status  Shows the mode of each CLI.
 *
 * Only the read tools get a rule; monday_write_back always asks. MONDAY_BRIDGE_CLIENTS limits the CLIs it changes,
 * as in the installer. Claude Code uses the profile in CLAUDE_CONFIG_DIR, Codex the folder in CODEX_HOME.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type ApprovalMode,
  type ApprovalState,
  agyRules,
  allowRulesState,
  applyAllowRules,
  applyCodexRules,
  claudeRules,
  codexHasServer,
  codexRulesState,
} from './approval.js'

interface Client {
  name: string
  file: string
  state: (text: string) => ApprovalState
  apply: (text: string, mode: ApprovalMode) => string
  /** Why the file cannot take the rules, or undefined when it can. */
  blocker?: (text: string) => string | undefined
}

const CLIENTS: Client[] = [
  {
    name: 'claude',
    file: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json'),
    state: (text) => allowRulesState(text, claudeRules),
    apply: (text, mode) => applyAllowRules(text, claudeRules, mode),
  },
  {
    name: 'codex',
    file: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
    state: codexRulesState,
    apply: applyCodexRules,
    blocker: (text) => (codexHasServer(text) ? undefined : 'monday-task-bridge is not registered'),
  },
  {
    name: 'agy',
    file: join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
    state: (text) => allowRulesState(text, agyRules),
    apply: (text, mode) => applyAllowRules(text, agyRules, mode),
  },
]

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'auto' && command !== 'manual' && command !== 'status') {
    process.stderr.write('Usage: approval-cli auto|manual|status\n')
    process.stderr.write('  auto    Agent CLIs read monday tasks without asking each time.\n')
    process.stderr.write('  manual  Agent CLIs ask before each read (their default).\n')
    process.stderr.write('  status  Show the mode of each agent CLI.\n')
    process.exit(1)
  }

  const wanted = (process.env.MONDAY_BRIDGE_CLIENTS || 'claude,codex,agy').split(',').map((name) => name.trim().toLowerCase())
  let failed = false

  for (const client of CLIENTS) {
    if (!wanted.includes(client.name)) continue
    // A CLI that never ran on this PC has no config folder.
    if (!existsSync(dirname(client.file))) {
      process.stderr.write(`  ${client.name}: not installed, skipped\n`)
      continue
    }
    try {
      const text = existsSync(client.file) ? await readFile(client.file, 'utf8') : ''
      const blocked = client.blocker?.(text)
      if (blocked) {
        process.stderr.write(`  ${client.name}: ${blocked}, skipped\n`)
        continue
      }
      const next = command === 'status' ? text : client.apply(text, command)
      if (next !== text) await writeFile(client.file, next)
      process.stderr.write(`  ${client.name}: ${client.state(next)} (${client.file})\n`)
    } catch (err: unknown) {
      failed = true
      const reason = err instanceof Error ? err.message : String(err)
      process.stderr.write(`  ${client.name}: could not update ${client.file}, left unchanged: ${reason}\n`)
    }
  }

  if (command !== 'status') {
    process.stderr.write('Restart open agent sessions to apply the change.\n')
  }
  if (failed) process.exit(1)
}

main()
