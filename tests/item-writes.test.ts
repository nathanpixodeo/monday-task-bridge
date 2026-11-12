import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Graphql } from '../extension/helpers/assigned-tasks.js'
import { performWrite, WriteTargetError } from '../extension/helpers/item-writes.js'

interface Call {
  host: string
  query: string
  variables: Record<string, unknown>
}

/** Fake of the worker's GraphQL call: answers by the operation's name, and records every call. */
function fakeGraphql(answers: Record<string, (call: Call) => unknown>): { graphql: Graphql; calls: Call[]; names: () => string[] } {
  const calls: Call[] = []
  const nameOf = (query: string) => /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? '?'
  const graphql: Graphql = async (host, query, variables) => {
    const call = { host, query, variables }
    calls.push(call)
    const answer = answers[nameOf(query)]
    if (answer === undefined) throw new Error(`no answer for ${nameOf(query)}`)
    return answer(call)
  }
  return { graphql, calls, names: () => calls.map((call) => nameOf(call.query)) }
}

const HOST = 'team.monday.com'

const columns = [
  { id: 'name', title: 'Name', type: 'name' },
  { id: 'status', title: 'Status', type: 'status' },
  { id: 'tags', title: 'Tags', type: 'tags' },
  { id: 'person', title: 'Owner', type: 'people' },
  { id: 'date4', title: 'Due date', type: 'date' },
  { id: 'timeline', title: 'Timeline', type: 'timeline' },
  { id: 'numbers', title: 'Estimate', type: 'numbers' },
  { id: 'text', title: 'Notes', type: 'text' },
  { id: 'long_text', title: 'Description', type: 'long_text' },
  { id: 'check', title: 'Reviewed', type: 'checkbox' },
  { id: 'dropdown', title: 'Platform', type: 'dropdown' },
  { id: 'link', title: 'PR', type: 'link' },
  { id: 'formula', title: 'Score', type: 'formula' }
]

function itemOn(boardId: string, values: Record<string, unknown> = {}, boardColumns: unknown[] = columns, id = '456') {
  return {
    items: [{
      id,
      board: { id: boardId, columns: boardColumns },
      group: { id: 'topics', title: 'This week' },
      column_values: Object.entries(values).map(([columnId, value]) => ({ id: columnId, value: JSON.stringify(value) }))
    }]
  }
}

/** The column values sent with the single WriteColumns call. */
function sentValues(calls: Call[]): Record<string, unknown> {
  const call = calls.find((entry) => entry.query.includes('mutation WriteColumns'))
  assert.ok(call, 'no WriteColumns call')
  return JSON.parse(call.variables.values as string)
}

test('adds an update with its text kept, and replies only to an update on the same item', async () => {
  const fake = fakeGraphql({
    WriteItem: () => itemOn('123'),
    WriteUpdateOf: (call) => ({ updates: [{ id: (call.variables.ids as string[])[0], item_id: call.variables.ids?.toString() === '77' ? '456' : '999' }] }),
    WriteAddUpdate: () => ({ create_update: { id: 901 } })
  })

  const added = await performWrite(fake.graphql, HOST, { op: 'add-update', boardId: '123', itemId: '456', body: 'Fixed <b>\nSee PR' })
  assert.deepEqual(added, { op: 'add-update', accountHost: HOST, boardId: '123', itemId: '456', updateId: '901' })
  assert.deepEqual(fake.calls[1].variables, { itemId: '456', body: 'Fixed &lt;b&gt;<br>See PR', parentId: null, mentions: null })

  const reply = await performWrite(fake.graphql, HOST, { op: 'add-update', boardId: '123', itemId: '456', body: 'Done', replyToUpdateId: '77' })
  assert.equal(reply.updateId, '901')
  assert.equal(fake.calls.at(-1)!.variables.parentId, '77')

  const before = fake.calls.length
  await assert.rejects(
    performWrite(fake.graphql, HOST, { op: 'add-update', boardId: '123', itemId: '456', body: 'Done', replyToUpdateId: '78' }),
    WriteTargetError
  )
  assert.ok(!fake.names().slice(before).includes('WriteAddUpdate'))
})

const tagOf = (id: number, name: string) =>
  `<a class="user_mention_editor router" href="https://${HOST}/users/${id}" data-mention-type="User" ` +
  `data-mention-id="${id}" target="_blank" rel="noopener noreferrer">@${name}</a>`

/** Update 77 is on item 456, reply 88 answers it, and update 99 is on another item. */
function updatesFake() {
  return fakeGraphql({
    WriteItem: () => ({ items: [{ ...itemOn('123').items[0], name: 'Withdraw' }] }),
    WriteUpdateOf: (call) => {
      const id = (call.variables.ids as string[])[0]
      if (id === '77') return { updates: [{ id, item_id: '456', text_body: 'Old text' }] }
      if (id === '99') return { updates: [{ id, item_id: '999', text_body: 'Elsewhere' }] }
      return { updates: [] }
    },
    WriteItemUpdates: () => ({ items: [{ updates: [{ id: '77', replies: [{ id: '88', text_body: 'Old reply' }] }] }] }),
    WriteMe: () => ({ me: { id: '10' } }),
    WriteUsersByName: () => ({ users: [] }),
    WriteUsersById: () => ({ users: [{ id: '10', name: 'Nathan' }] }),
    WriteEditUpdate: (call) => ({ edit_update: { id: call.variables.id } }),
    WriteDeleteUpdate: (call) => ({ delete_update: { id: call.variables.id } })
  })
}

test('edits an update or a reply on the item, with its text written as for a new update', async () => {
  const fake = updatesFake()
  const edited = await performWrite(fake.graphql, HOST, {
    op: 'edit-update', boardId: '123', itemId: '456', updateId: '77', body: 'Fixed <b>\n@Nathan see PR', mentions: ['me']
  })
  assert.deepEqual(edited, {
    op: 'edit-update', accountHost: HOST, boardId: '123', itemId: '456', updateId: '77', mentioned: ['Nathan'], itemName: 'Withdraw'
  })
  const call = fake.calls.find((entry) => entry.query.includes('mutation WriteEditUpdate'))!
  assert.deepEqual(call.variables, { id: '77', body: `Fixed &lt;b&gt;<br>${tagOf(10, 'Nathan')} see PR` })

  const reply = await performWrite(fake.graphql, HOST, { op: 'edit-update', boardId: '123', itemId: '456', updateId: '88', body: 'Thanks' })
  assert.equal(reply.updateId, '88')
  assert.deepEqual(fake.calls.at(-1)!.variables, { id: '88', body: 'Thanks' })
})

test('deletes an update or a reply on the item, and hands back the text it had', async () => {
  const fake = updatesFake()
  const deleted = await performWrite(fake.graphql, HOST, { op: 'delete-update', boardId: '123', itemId: '456', updateId: '77' })
  assert.deepEqual(deleted, {
    op: 'delete-update', accountHost: HOST, boardId: '123', itemId: '456', updateId: '77', deletedBody: 'Old text', itemName: 'Withdraw'
  })
  assert.deepEqual(fake.calls.at(-1)!.variables, { id: '77' })

  const reply = await performWrite(fake.graphql, HOST, { op: 'delete-update', boardId: '123', itemId: '456', updateId: '88' })
  assert.equal(reply.deletedBody, 'Old reply')
})

test('never edits or deletes an update that is not on the item, and replies only to an update, not a reply', async () => {
  const fake = updatesFake()
  for (const updateId of ['99', '55']) {
    await assert.rejects(performWrite(fake.graphql, HOST, { op: 'edit-update', boardId: '123', itemId: '456', updateId, body: 'x' }), WriteTargetError)
    await assert.rejects(performWrite(fake.graphql, HOST, { op: 'delete-update', boardId: '123', itemId: '456', updateId }), WriteTargetError)
  }
  await assert.rejects(
    performWrite(fake.graphql, HOST, { op: 'add-update', boardId: '123', itemId: '456', body: 'x', replyToUpdateId: '88' }),
    WriteTargetError
  )
  for (const name of ['WriteEditUpdate', 'WriteDeleteUpdate', 'WriteAddUpdate']) assert.ok(!fake.names().includes(name), name)
  // A name that matches no one leaves the update as it was
  await assert.rejects(performWrite(fake.graphql, HOST, {
    op: 'edit-update', boardId: '123', itemId: '456', updateId: '77', body: 'x', mentions: ['Nobody Here']
  }), /No monday user is named "Nobody Here"/)
  assert.ok(!fake.names().includes('WriteEditUpdate'))
})

test('tags people in an update where the body names them, else at its start, and notifies each once', async () => {
  const users = [
    { id: 10, name: 'Me <Admin>', email: 'me@team.com' },
    { id: 11, name: 'An', email: 'an@team.com' },
    { id: 12, name: 'An Nguyen', email: 'an.nguyen@team.com' },
    { id: 13, name: 'Lan Tran', email: 'lan@team.com' }
  ]
  const fake = fakeGraphql({
    WriteItem: () => ({ items: [{ ...itemOn('123').items[0], name: ' Withdraw ' }] }),
    WriteMe: () => ({ me: { id: '10' } }),
    WriteUsersByEmail: (call) => ({ users: users.filter((user) => (call.variables.emails as string[]).includes(user.email)) }),
    WriteUsersByName: (call) => ({ users: users.filter((user) => user.name.includes(call.variables.name as string)) }),
    WriteUsersById: (call) => ({ users: users.filter((user) => (call.variables.ids as string[]).includes(String(user.id))) }),
    WriteAddUpdate: () => ({ create_update: { id: 902 } })
  })

  const added = await performWrite(fake.graphql, HOST, {
    op: 'add-update',
    boardId: '123',
    itemId: '456',
    body: '@an nguyen and @An, see this.\n@Lan Trang is not Lan',
    mentions: ['An Nguyen', 'an@team.com', 'me', '13', '11']
  })
  assert.deepEqual(added, {
    op: 'add-update',
    accountHost: HOST,
    boardId: '123',
    itemId: '456',
    updateId: '902',
    mentioned: ['An Nguyen', 'An', 'Me <Admin>', 'Lan Tran'],
    itemName: 'Withdraw'
  })
  const sent = fake.calls.find((call) => call.query.includes('mutation WriteAddUpdate'))!.variables
  assert.equal(
    sent.body,
    `${tagOf(10, 'Me &lt;Admin&gt;')} ${tagOf(13, 'Lan Tran')} ${tagOf(12, 'An Nguyen')} and ${tagOf(11, 'An')}, see this.<br>@Lan Trang is not Lan`
  )
  assert.deepEqual(sent.mentions, [
    { id: '12', type: 'User' },
    { id: '11', type: 'User' },
    { id: '10', type: 'User' },
    { id: '13', type: 'User' }
  ])

  const before = fake.calls.length
  await assert.rejects(
    performWrite(fake.graphql, HOST, { op: 'add-update', boardId: '123', itemId: '456', body: 'Hi', mentions: ['Nobody Here'] }),
    /No monday user is named "Nobody Here"/
  )
  await assert.rejects(
    performWrite(fake.graphql, HOST, { op: 'add-update', boardId: '123', itemId: '456', body: 'Hi', mentions: ['99'] }),
    /No monday user has the id 99/
  )
  assert.ok(!fake.names().slice(before).includes('WriteAddUpdate'))
})

test('writes nothing to an item it cannot see, or one on another board', async () => {
  for (const answer of [{ items: [] }, itemOn('999')]) {
    const fake = fakeGraphql({ WriteItem: () => answer })
    await assert.rejects(
      performWrite(fake.graphql, HOST, { op: 'update-item', boardId: '123', itemId: '456', columns: { Status: 'Done' } }),
      WriteTargetError
    )
    assert.deepEqual(fake.names(), ['WriteItem'])
  }
})

test('sets every column in one change, by title or id, in the JSON each column type takes', async () => {
  const fake = fakeGraphql({
    WriteItem: () => itemOn('123'),
    WriteColumns: () => ({ change_multiple_column_values: { id: '456' } })
  })

  const result = await performWrite(fake.graphql, HOST, {
    op: 'update-item',
    boardId: '123',
    itemId: '456',
    createMissingLabels: true,
    columns: {
      status: 'Done',
      'due DATE': '2026-11-20 09:30',
      Timeline: { from: '2026-11-01', to: '2026-11-30' },
      Estimate: '3.5',
      Notes: 'short',
      Description: 'long\ntext',
      Reviewed: true,
      Platform: ['Web', 'iOS'],
      PR: { url: 'https://github.com/x/y/pull/1', text: 'PR #1' },
      Name: '  Renamed task ',
      text: null
    }
  }).catch((err) => err)

  // "Notes" and "text" are the same column
  assert.match(String(result), /Column Notes is given twice/)

  const ok = await performWrite(fake.graphql, HOST, {
    op: 'update-item',
    boardId: '123',
    itemId: '456',
    createMissingLabels: true,
    columns: {
      status: 'Done',
      'due DATE': '2026-11-20 09:30',
      Timeline: { from: '2026-11-01', to: '2026-11-30' },
      Estimate: '3.5',
      Description: 'long\ntext',
      Reviewed: true,
      Platform: ['Web', 'iOS'],
      PR: { url: 'https://github.com/x/y/pull/1', text: 'PR #1' },
      Name: '  Renamed task ',
      text: null
    }
  })

  assert.deepEqual(ok.columnsSet, ['Status', 'Due date', 'Timeline', 'Estimate', 'Description', 'Reviewed', 'Platform', 'PR', 'Name', 'Notes'])
  assert.deepEqual(sentValues(fake.calls), {
    status: { label: 'Done' },
    date4: { date: '2026-11-20', time: '09:30:00' },
    timeline: { from: '2026-11-01', to: '2026-11-30' },
    numbers: '3.5',
    long_text: { text: 'long\ntext' },
    check: { checked: 'true' },
    dropdown: { labels: ['Web', 'iOS'] },
    link: { url: 'https://github.com/x/y/pull/1', text: 'PR #1' },
    name: 'Renamed task',
    text: null
  })
  const write = fake.calls.find((call) => call.query.includes('mutation WriteColumns'))!
  assert.equal(write.variables.boardId, '123')
  assert.equal(write.variables.itemId, '456')
  assert.equal(write.variables.createLabels, true)
})

test('refuses values a column cannot take, unknown or ambiguous columns, and types it cannot set, before writing', async () => {
  const twoStatus = [...columns, { id: 'status_2', title: 'status', type: 'status' }]
  const cases: Array<[Record<string, unknown>, RegExp, unknown[]?]> = [
    [{ 'Due date': '20/11/2026' }, /takes a date/],
    [{ Estimate: 'three' }, /takes a number/],
    [{ Reviewed: 'yes' }, /takes true or false/],
    [{ PR: 'javascript:alert(1)' }, /http\(s\) URL/],
    [{ Timeline: { from: '2026-11-01', to: 'later' } }, /from: "YYYY-MM-DD"/],
    [{ Name: null }, /cannot be cleared/],
    [{ Priority: 'High' }, /has no column "Priority". Its columns: Name \(name, name\)/],
    [{ Score: 5 }, /formula column, which cannot be set yet/],
    [{ Status: 'Done' }, /2 columns titled "Status"; use one of their ids: status, status_2/, twoStatus]
  ]
  for (const [values, error, boardColumns] of cases) {
    const fake = fakeGraphql({ WriteItem: () => itemOn('123', {}, boardColumns ?? columns) })
    await assert.rejects(
      performWrite(fake.graphql, HOST, { op: 'update-item', boardId: '123', itemId: '456', columns: values as never }),
      error,
      JSON.stringify(values)
    )
    assert.deepEqual(fake.names(), ['WriteItem'])
  }
})

test('adds and removes tags on the current ones, and creates a missing tag only when asked', async () => {
  const answers = (boardKind: string) => ({
    WriteItem: () => itemOn('123', { tags: { tag_ids: [1, 2] } }),
    WriteTags: () => ({ boards: [{ board_kind: boardKind, tags: [{ id: '3', name: 'Backend' }] }], tags: [{ id: 1, name: 'urgent' }, { id: 2, name: 'Bug' }] }),
    WriteCreateTag: (call: Call) => ({ create_or_get_tag: { id: '50', name: call.variables.name } }),
    WriteColumns: () => ({ change_multiple_column_values: { id: '456' } })
  })

  const merge = fakeGraphql(answers('public'))
  await performWrite(merge.graphql, HOST, {
    op: 'update-item', boardId: '123', itemId: '456', columns: { Tags: { add: ['backend'], remove: ['Bug', 'never-there'] } }
  })
  assert.deepEqual(sentValues(merge.calls), { tags: { tag_ids: [1, 3] } })

  const missing = fakeGraphql(answers('public'))
  await assert.rejects(
    performWrite(missing.graphql, HOST, { op: 'update-item', boardId: '123', itemId: '456', columns: { Tags: ['Bug', 'Release'] } }),
    /No tag named "Release" exists; pass createMissingTags/
  )
  assert.ok(!missing.names().includes('WriteColumns'))

  for (const [kind, boardId] of [['public', null], ['private', '123']] as const) {
    const create = fakeGraphql(answers(kind))
    const result = await performWrite(create.graphql, HOST, {
      op: 'update-item', boardId: '123', itemId: '456', createMissingTags: true, columns: { Tags: ['Bug', 'Release'] }
    })
    assert.deepEqual(sentValues(create.calls), { tags: { tag_ids: [2, 50] } })
    assert.deepEqual(result.created, ['tag Release'])
    assert.equal(create.calls.find((call) => call.query.includes('WriteCreateTag'))!.variables.boardId, boardId)
  }
})

test('assigns people by "me", email, id or exact name, keeps teams on add or remove, and refuses an unclear name', async () => {
  const users = [
    { id: 11, name: 'Lan Tran', email: 'lan@team.com' },
    { id: 12, name: 'Minh Le', email: 'minh@team.com' },
    { id: 13, name: 'Minh Le', email: 'minh.le@other.com' },
    { id: 14, name: 'Minh Leanne', email: 'leanne@team.com' }
  ]
  const answers = {
    WriteItem: () => itemOn('123', { person: { personsAndTeams: [{ id: 11, kind: 'person' }, { id: 90, kind: 'team' }] } }),
    WriteMe: () => ({ me: { id: '10' } }),
    WriteUsersByEmail: (call: Call) => ({ users: users.filter((user) => (call.variables.emails as string[]).includes(user.email)) }),
    WriteUsersByName: (call: Call) => ({ users: users.filter((user) => user.name.includes(call.variables.name as string)) }),
    WriteColumns: () => ({ change_multiple_column_values: { id: '456' } })
  }

  const set = fakeGraphql(answers)
  await performWrite(set.graphql, HOST, { op: 'update-item', boardId: '123', itemId: '456', columns: { Owner: ['me', 'LAN@team.com', '15'] } })
  assert.deepEqual(sentValues(set.calls), {
    person: { personsAndTeams: [{ id: 10, kind: 'person' }, { id: 11, kind: 'person' }, { id: 15, kind: 'person' }] }
  })

  const change = fakeGraphql(answers)
  await performWrite(change.graphql, HOST, {
    op: 'update-item', boardId: '123', itemId: '456', columns: { Owner: { add: ['Minh Leanne', 'me'], remove: ['lan@team.com'] } }
  })
  assert.deepEqual(sentValues(change.calls), {
    person: { personsAndTeams: [{ id: 90, kind: 'team' }, { id: 14, kind: 'person' }, { id: 10, kind: 'person' }] }
  })

  await assert.rejects(
    performWrite(fakeGraphql(answers).graphql, HOST, { op: 'update-item', boardId: '123', itemId: '456', columns: { Owner: ['Minh Le'] } }),
    /2 monday users are named "Minh Le"; use an email instead: minh@team.com, minh.le@other.com/
  )
  await assert.rejects(
    performWrite(fakeGraphql(answers).graphql, HOST, { op: 'update-item', boardId: '123', itemId: '456', columns: { Owner: ['Minh'] } }),
    /No monday user is named "Minh"; did you mean: Minh Le/
  )
  await assert.rejects(
    performWrite(fakeGraphql(answers).graphql, HOST, { op: 'update-item', boardId: '123', itemId: '456', columns: { Owner: ['nobody@team.com'] } }),
    /No monday user has the email nobody@team.com/
  )
})

test('creates an item in a group found by title, and a subitem whose columns are set on its own board', async () => {
  const subitemColumns = [{ id: 'status', title: 'Status', type: 'status' }]
  const fake = fakeGraphql({
    WriteGroups: () => ({ boards: [{ groups: [{ id: 'topics', title: 'This week' }, { id: 'done', title: 'Done' }] }] }),
    WriteCreateItem: (call) => ({ create_item: { id: '700', board: { id: '123' }, group: { id: call.variables.groupId, title: 'Done' } } }),
    WriteItem: (call) => (call.variables.ids as string[])[0] === '801' ? itemOn('555', {}, subitemColumns, '801') : itemOn('123'),
    WriteCreateSubitem: () => ({ create_subitem: { id: '801', board: { id: '555' } } }),
    WriteColumns: () => ({ change_multiple_column_values: { id: '801' } })
  })

  const item = await performWrite(fake.graphql, HOST, { op: 'create-item', boardId: '123', name: ' Write docs ', group: 'done' })
  assert.deepEqual(item, { op: 'create-item', accountHost: HOST, boardId: '123', itemId: '700', group: { id: 'done', title: 'Done' }, itemName: 'Write docs' })
  assert.deepEqual(fake.calls[1].variables, { boardId: '123', groupId: 'done', name: 'Write docs' })

  const subitem = await performWrite(fake.graphql, HOST, {
    op: 'create-item', boardId: '123', name: 'Check login', parentItemId: '456', columns: { Status: 'Working on it' }
  })
  assert.deepEqual(subitem, { op: 'create-item', accountHost: HOST, boardId: '555', itemId: '801', columnsSet: ['Status'], itemName: 'Check login' })
  const write = fake.calls.find((call) => call.query.includes('mutation WriteColumns'))!
  assert.deepEqual([write.variables.boardId, write.variables.itemId], ['555', '801'])

  await assert.rejects(
    performWrite(fake.graphql, HOST, { op: 'create-item', boardId: '123', name: 'x', parentItemId: '456', group: 'Done' }),
    /leave group out with parentItemId/
  )
})

test('says the item was created when its columns could not be set afterwards', async () => {
  const fake = fakeGraphql({
    WriteCreateItem: () => ({ create_item: { id: '700', board: { id: '123' }, group: { id: 'topics', title: 'This week' } } }),
    WriteItem: () => itemOn('123', {}, columns, '700'),
    WriteColumns: () => { throw new Error("monday API: This status label doesn't exist") }
  })
  await assert.rejects(
    performWrite(fake.graphql, HOST, { op: 'create-item', boardId: '123', name: 'New', columns: { Status: 'Shipped' } }),
    /Created item 700 on board 123, but could not set its columns: Could not set Status: monday API: This status label doesn't exist/
  )
})

test('moves an item to a group by title, and names the groups when none matches', async () => {
  const fake = fakeGraphql({
    WriteItem: () => itemOn('123'),
    WriteGroups: () => ({ boards: [{ groups: [{ id: 'topics', title: 'This week' }, { id: 'done', title: 'Done' }] }] }),
    WriteMoveItem: () => ({ move_item_to_group: { id: '456' } })
  })

  const moved = await performWrite(fake.graphql, HOST, { op: 'move-item', boardId: '123', itemId: '456', group: 'DONE' })
  assert.deepEqual(moved, { op: 'move-item', accountHost: HOST, boardId: '123', itemId: '456', group: { id: 'done', title: 'Done' } })
  assert.deepEqual(fake.calls.at(-1)!.variables, { itemId: '456', groupId: 'done' })

  const before = fake.calls.length
  await assert.rejects(
    performWrite(fake.graphql, HOST, { op: 'move-item', boardId: '123', itemId: '456', group: 'Later' }),
    /has no group "Later". Its groups: This week \(topics\); Done \(done\)/
  )
  assert.ok(!fake.names().slice(before).includes('WriteMoveItem'))
})
