import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  READ_TOOLS,
  agyRules,
  allowRulesState,
  applyAllowRules,
  applyCodexRules,
  claudeRules,
  codexHasServer,
  codexRulesState,
} from '../bridge/approval.js'

test('read rules never cover monday_write_back', () => {
  assert.ok(!(READ_TOOLS as readonly string[]).includes('monday_write_back'))
  assert.ok(claudeRules.every((rule) => !rule.includes('write_back')))
  assert.equal(claudeRules[0], 'mcp__monday-task-bridge__monday_read_task')
  assert.equal(agyRules[0], 'mcp(monday-task-bridge/monday_read_task)')
})

test('applyAllowRules adds the rules once and keeps every other setting', () => {
  const before = JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm)'] } })
  const auto = applyAllowRules(before, claudeRules, 'auto')
  const settings = JSON.parse(auto)
  assert.equal(settings.model, 'opus')
  assert.deepEqual(settings.permissions.deny, ['Bash(rm)'])
  assert.deepEqual(settings.permissions.allow, ['Bash(ls)', ...claudeRules])
  assert.equal(allowRulesState(auto, claudeRules), 'auto')
  // Running auto again adds no duplicate.
  assert.equal(applyAllowRules(auto, claudeRules, 'auto'), auto)
})

test('applyAllowRules manual removes only the bridge rules', () => {
  const auto = applyAllowRules(JSON.stringify({ permissions: { allow: ['read(*)'] } }), agyRules, 'auto')
  const manual = applyAllowRules(auto, agyRules, 'manual')
  assert.deepEqual(JSON.parse(manual).permissions.allow, ['read(*)'])
  assert.equal(allowRulesState(manual, agyRules), 'manual')
})

test('applyAllowRules starts a missing or empty settings file', () => {
  assert.deepEqual(JSON.parse(applyAllowRules('', claudeRules, 'auto')), { permissions: { allow: claudeRules } })
  assert.throws(() => applyAllowRules('{ not json', claudeRules, 'auto'))
})

const CODEX = [
  'model = "gpt"',
  '',
  '[mcp_servers.monday-task-bridge]',
  'command = "node"',
  "args = ['C:\\bridge\\mcp.js']",
  '',
  '[mcp_servers.other]',
  'command = "x"',
  '',
].join('\n')

test('applyCodexRules approves each read tool and keeps the rest of the file', () => {
  assert.ok(codexHasServer(CODEX))
  const auto = applyCodexRules(CODEX, 'auto')
  assert.ok(auto.startsWith(CODEX.trimEnd()))
  assert.match(auto, /\[mcp_servers\.monday-task-bridge\.tools\.monday_read_task\]\napproval_mode = "approve"/)
  assert.doesNotMatch(auto, /monday_write_back/)
  assert.equal(codexRulesState(auto), 'auto')
  assert.equal(applyCodexRules(auto, 'auto'), auto)
})

test('applyCodexRules manual removes the tool tables, even after other tables', () => {
  const auto = applyCodexRules(CODEX, 'auto') + '\n[profiles.fast]\nmodel = "mini"\n'
  const manual = applyCodexRules(auto, 'manual')
  assert.doesNotMatch(manual, /tools\.monday_/)
  assert.match(manual, /\[profiles\.fast\]\nmodel = "mini"/)
  assert.match(manual, /\[mcp_servers\.other\]/)
  assert.equal(codexRulesState(manual), 'manual')
})

test('applyCodexRules keeps CRLF line endings and spots a missing server', () => {
  const crlf = CODEX.replace(/\n/g, '\r\n')
  assert.ok(!applyCodexRules(crlf, 'auto').replace(/\r\n/g, '').includes('\n'))
  assert.ok(!codexHasServer('[mcp_servers.other]\ncommand = "x"\n'))
})
