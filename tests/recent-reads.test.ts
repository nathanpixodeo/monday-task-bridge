import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RECENT_READS, addRecentRead, agentLabel, cleanAgentName } from '../extension/helpers/recent-reads.js'
import type { RecentRead } from '../extension/helpers/recent-reads.js'

const read = (n: number): RecentRead => ({
  title: `Task ${n}`,
  url: `https://team.monday.com/boards/1/pulses/${n}`,
  at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  complete: true,
  warnings: [],
  agent: 'claude-code'
})

test('the read history puts the newest read first and keeps the last ten', () => {
  let reads: RecentRead[] = []
  for (let n = 1; n <= 12; n++) reads = addRecentRead(reads, read(n))
  assert.equal(reads.length, MAX_RECENT_READS)
  assert.deepEqual(reads.map((r) => r.title), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `Task ${n}`))
})

test('an agent name is kept only when it is short printable text', () => {
  assert.equal(cleanAgentName('  claude-code '), 'claude-code')
  assert.equal(cleanAgentName('Visual Studio Code'), 'Visual Studio Code')
  for (const bad of [undefined, null, 42, '', '   ', 'a'.repeat(65), 'bad\nname', 'naïve']) {
    assert.equal(cleanAgentName(bad), null, JSON.stringify(bad))
  }
})

test('the popup names the agents it knows and shows any other name as given', () => {
  assert.equal(agentLabel('claude-code'), 'Claude Code')
  assert.equal(agentLabel('codex-mcp-client'), 'Codex')
  assert.equal(agentLabel('antigravity-client'), 'agy')
  assert.equal(agentLabel('gemini-cli-mcp-client'), 'Gemini CLI')
  assert.equal(agentLabel('my-agent'), 'my-agent')
  assert.equal(agentLabel(null), 'Unknown agent')
})
