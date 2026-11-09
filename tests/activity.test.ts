import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ACTIVITY,
  MAX_BODY_LENGTH,
  activityLabel,
  addActivity,
  agentLabel,
  cleanAgentName,
  describeColumnInput,
  legacyReads,
  writeActivity,
  writeBackActivity
} from '../extension/helpers/activity.js'
import type { ActivityEntry } from '../extension/helpers/activity.js'

const HOST = 'team.monday.com'
const AT = '2026-11-09T04:00:00.000Z'

const read = (n: number): ActivityEntry => ({
  kind: 'read',
  title: `Task ${n}`,
  url: `https://${HOST}/boards/1/pulses/${n}`,
  at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  agent: 'claude-code',
  ok: true,
  warnings: []
})

test('the activity log puts the newest entry first and keeps the last fifty', () => {
  let log: ActivityEntry[] = []
  for (let n = 1; n <= 52; n++) log = addActivity(log, read(n))
  assert.equal(log.length, MAX_ACTIVITY)
  assert.equal(log[0].title, 'Task 52')
  assert.equal(log.at(-1)!.title, 'Task 3')
})

test('a column value reads the way the agent gave it', () => {
  assert.equal(describeColumnInput('Done'), 'Done')
  assert.equal(describeColumnInput(3.5), '3.5')
  assert.equal(describeColumnInput(true), 'checked')
  assert.equal(describeColumnInput(false), 'unchecked')
  assert.equal(describeColumnInput(null), 'cleared')
  assert.equal(describeColumnInput(['me', 'lan@team.com']), 'me, lan@team.com')
  assert.equal(describeColumnInput({ add: ['urgent'], remove: ['later'] }), '+urgent, -later')
  assert.equal(describeColumnInput({ from: '2026-11-01', to: '2026-11-09' }), '2026-11-01 → 2026-11-09')
  assert.equal(describeColumnInput({ url: 'https://x.dev/pr/1' }), 'https://x.dev/pr/1')
  assert.equal(describeColumnInput({ url: 'https://x.dev/pr/1', text: 'PR 1' }), 'PR 1 (https://x.dev/pr/1)')
})

test('an update logs its text, the people tagged, and a link to the update', () => {
  const entry = writeActivity(
    HOST,
    { op: 'add-update', boardId: '123', itemId: '456', body: 'x'.repeat(MAX_BODY_LENGTH + 10), mentions: ['me', 'Lan'] },
    { result: { op: 'add-update', accountHost: HOST, boardId: '123', itemId: '456', updateId: '901', mentioned: ['Nathan', 'Lan Tran'] }, itemName: 'Withdraw' },
    'claude-code',
    AT
  )
  assert.equal(entry.body!.length, MAX_BODY_LENGTH)
  assert.ok(entry.body!.endsWith('…'))
  assert.deepEqual({ ...entry, body: undefined }, {
    kind: 'add-update',
    title: 'Withdraw',
    url: `https://${HOST}/boards/123/pulses/456`,
    at: AT,
    agent: 'claude-code',
    ok: true,
    warnings: [],
    body: undefined,
    updateUrl: `https://${HOST}/boards/123/pulses/456/posts/901`,
    mentioned: ['Nathan', 'Lan Tran']
  })
  assert.equal(activityLabel(entry), 'Update')

  const reply = writeActivity(
    HOST,
    { op: 'add-update', boardId: '123', itemId: '456', body: 'Thanks', replyToUpdateId: '77' },
    { result: { op: 'add-update', accountHost: HOST, boardId: '123', itemId: '456', updateId: '902' } },
    null,
    AT
  )
  assert.equal(reply.title, 'Item 456')
  assert.equal(reply.replyTo, '77')
  assert.equal(activityLabel(reply), 'Reply')
})

test('a column change logs each column by its title, and a failed one by the names given, with the error', () => {
  const columns = { status: 'Done', Owner: { add: ['me'] }, 'Due date': null }
  const done = writeActivity(
    HOST,
    { op: 'update-item', boardId: '123', itemId: '456', columns },
    { result: { op: 'update-item', accountHost: HOST, boardId: '123', itemId: '456', columnsSet: ['Status', 'Owner', 'Due date'], created: ['tag x'] } },
    'codex',
    AT
  )
  assert.deepEqual(done.columns, [
    { title: 'Status', value: 'Done' },
    { title: 'Owner', value: '+me' },
    { title: 'Due date', value: 'cleared' }
  ])
  assert.deepEqual(done.created, ['tag x'])
  assert.equal(done.ok, true)

  const failed = writeActivity(HOST, { op: 'update-item', boardId: '123', itemId: '456', columns }, { error: new Error('Board 123 has no column "status"') }, 'codex', AT)
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'Board 123 has no column "status"')
  assert.equal(failed.title, 'Item 456')
  assert.deepEqual(failed.columns?.map((column) => column.title), ['status', 'Owner', 'Due date'])
})

test('a new item and a move log the group, and a new item its own name', () => {
  const created = writeActivity(
    HOST,
    { op: 'create-item', boardId: '123', name: ' Payout API ', group: 'Backlog' },
    { result: { op: 'create-item', accountHost: HOST, boardId: '123', itemId: '789', group: { id: 'topics', title: 'Backlog' } } },
    null,
    AT
  )
  assert.equal(created.title, 'Payout API')
  assert.equal(created.url, `https://${HOST}/boards/123/pulses/789`)
  assert.equal(created.group, 'Backlog')
  assert.equal(created.columns, undefined)

  const failedSubitem = writeActivity(HOST, { op: 'create-item', boardId: '123', name: 'Step 1', parentItemId: '456' }, { error: 'nope' }, null, AT)
  assert.equal(failedSubitem.url, `https://${HOST}/boards/123/pulses/456`)
  assert.equal(failedSubitem.error, 'nope')

  const moved = writeActivity(
    HOST,
    { op: 'move-item', boardId: '123', itemId: '456', group: 'done' },
    { result: { op: 'move-item', accountHost: HOST, boardId: '123', itemId: '456', group: { id: 'done', title: 'Done' } } },
    null,
    AT
  )
  assert.equal(moved.group, 'Done')
  assert.equal(activityLabel(moved), 'Move')
})

test('a write-back logs its comment, its status, and a link to the update', () => {
  const entry = writeBackActivity(
    { accountHost: 'Team.monday.com', boardId: '123', itemId: '456', comment: 'Shipped', statusLabel: 'Done' },
    { result: { updateId: '903', statusSet: true }, itemName: 'Withdraw' },
    null,
    AT
  )
  assert.deepEqual(entry, {
    kind: 'write-back',
    title: 'Withdraw',
    url: `https://${HOST}/boards/123/pulses/456`,
    at: AT,
    agent: null,
    ok: true,
    warnings: [],
    body: 'Shipped',
    updateUrl: `https://${HOST}/boards/123/pulses/456/posts/903`,
    status: 'Done'
  })
})

test('reads logged before writes were carry over as reads', () => {
  const old = [
    { title: 'Task 1', url: `https://${HOST}/boards/1/pulses/1`, at: AT, complete: false, warnings: ['No images', 3], agent: 'codex' },
    { title: 'Bad', at: AT },
    null
  ]
  assert.deepEqual(legacyReads(old), [
    { kind: 'read', title: 'Task 1', url: `https://${HOST}/boards/1/pulses/1`, at: AT, agent: 'codex', ok: false, warnings: ['No images'] }
  ])
  assert.deepEqual(legacyReads(undefined), [])
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
