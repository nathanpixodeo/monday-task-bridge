import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { readAssignedTasks, type Graphql } from '../extension/helpers/assigned-tasks.js'

interface Call {
  query: string
  variables: Record<string, unknown>
}

/** Fake of the worker's GraphQL call: resolves with the `data` object, like the real one. */
function fakeGraphql(answer: (call: Call) => unknown): { graphql: Graphql; calls: Call[] } {
  const calls: Call[] = []
  const graphql: Graphql = async (_host, query, variables) => {
    const call = { query, variables }
    calls.push(call)
    return answer(call)
  }
  return { graphql, calls }
}

const named = (call: Call, name: string) => call.query.includes(name)

function board(id: string, columns: Array<{ id: string; type: string }>) {
  return { id, name: `Board ${id}`, columns }
}

function itemsPage(cursor: string | null, items: unknown[]) {
  return { boards: [{ items_page: { cursor, items } }] }
}

function item(id: string, name = `Task ${id}`, columnValues: unknown[] = []) {
  return { id, name, column_values: columnValues }
}

const people = [{ id: 'person', type: 'people' }]

test('rejects invalid hosts with slash, port, credentials, or non-subdomains', async () => {
  const { graphql, calls } = fakeGraphql(() => ({}))

  await assert.rejects(readAssignedTasks('monday.com', graphql), /strict subdomain/)
  await assert.rejects(readAssignedTasks('https://foo.monday.com', graphql), /invalid characters/)
  await assert.rejects(readAssignedTasks('foo.monday.com:443', graphql), /invalid characters/)
  await assert.rejects(readAssignedTasks('user:pass@foo.monday.com', graphql), /invalid characters/)
  await assert.rejects(readAssignedTasks('foo.monday.com/boards', graphql), /invalid characters/)
  await assert.rejects(readAssignedTasks('evil.com', graphql), /strict subdomain/)
  await assert.rejects(readAssignedTasks('monday.com.evil.com', graphql), /strict subdomain/)
  await assert.rejects(readAssignedTasks('-bad.monday.com', graphql), /Invalid subdomain label format/)
  assert.equal(calls.length, 0)
})

test('rejects non-positive or non-finite limit options', async () => {
  const { graphql } = fakeGraphql(() => ({}))

  await assert.rejects(readAssignedTasks('corp.monday.com', graphql, { maxBoards: 0 }), /maxBoards must be a positive integer/)
  await assert.rejects(readAssignedTasks('corp.monday.com', graphql, { maxTasks: -5 }), /maxTasks must be a positive integer/)
  await assert.rejects(readAssignedTasks('corp.monday.com', graphql, { deadlineMs: NaN }), /deadlineMs must be a positive number/)
})

test('rejects when the authenticated user query fails or returns no user', async () => {
  const failing = fakeGraphql(() => {
    throw new Error('Network authentication error')
  })
  await assert.rejects(readAssignedTasks('corp.monday.com', failing.graphql), /Network authentication error/)

  const noUser = fakeGraphql(() => ({ me: null, boards: [] }))
  await assert.rejects(readAssignedTasks('corp.monday.com', noUser.graphql), /authenticated user not found/)

  const noBoards = fakeGraphql(() => ({ me: { id: '1', name: 'User' }, boards: null }))
  await assert.rejects(readAssignedTasks('corp.monday.com', noBoards.graphql), /unexpected boards response/)
})

test('returns complete true for a legitimate empty result', async () => {
  const { graphql, calls } = fakeGraphql(() => ({ me: { id: '123', name: ' Alice Developer ' }, boards: [] }))

  const result = await readAssignedTasks('My-Team.monday.com', graphql)
  assert.equal(result.accountHost, 'my-team.monday.com')
  assert.deepEqual(result.user, { id: '123', name: 'Alice Developer' })
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.complete, true)
  assert.ok(!Number.isNaN(Date.parse(result.checkedAt)))
  assert.deepEqual(calls[0].variables, { page: 1 })
})

test('skips boards without people columns and queries only boards with people columns', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return {
        me: { id: '99', name: 'Bob' },
        boards: [
          board('101', [{ id: 'status', type: 'status' }]),
          board('202', [{ id: 'status', type: 'status' }, { id: 'assignee', type: 'people' }])
        ]
      }
    }
    return itemsPage(null, [
      item('301', 'Task 1', [
        { id: 'status', text: 'In Progress', column: { title: 'Status' } },
        { id: 'date', text: '', column: { title: 'Due' } },
        { id: 'notes', text: 'Check it', column: null }
      ])
    ])
  })

  const result = await readAssignedTasks('team.monday.com', graphql)
  const boardCalls = calls.filter((call) => named(call, 'GetBoardAssignedItems'))
  assert.deepEqual(boardCalls.map((call) => call.variables.ids), [['202']])
  assert.deepEqual(result.tasks, [{
    accountHost: 'team.monday.com',
    boardId: '202',
    boardName: 'Board 202',
    itemId: '301',
    title: 'Task 1',
    sourceUrl: 'https://team.monday.com/boards/202/pulses/301',
    fields: { Status: 'In Progress', notes: 'Check it' },
    // An item without a group gets none; its non-empty columns keep the order monday gave them.
    columns: [
      { id: 'status', title: 'Status', type: '', text: 'In Progress', color: null },
      { id: 'notes', title: 'notes', type: '', text: 'Check it', color: null }
    ]
  }])
  assert.equal(result.complete, true)
})

test('filters every people column with assigned_to_me, combined with or, through variables only', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return {
        me: { id: '1', name: 'Dev' },
        boards: [board('500', [
          { id: 'lead', type: 'people' },
          { id: 'reviewer', type: 'people' },
          { id: 'status', type: 'status' }
        ])]
      }
    }
    return itemsPage(null, [])
  })

  await readAssignedTasks('org.monday.com', graphql)

  const boardCall = calls.find((call) => named(call, 'GetBoardAssignedItems'))
  assert.ok(boardCall)
  assert.deepEqual(boardCall.variables, {
    ids: ['500'],
    params: {
      operator: 'or',
      rules: [
        { column_id: 'lead', compare_value: ['assigned_to_me'], operator: 'any_of' },
        { column_id: 'reviewer', compare_value: ['assigned_to_me'], operator: 'any_of' }
      ]
    }
  })
  // IDs never reach the query text
  assert.ok(calls.every((call) => !call.query.includes('500')))
})

test('pages through boards and follows next_items_page cursors', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return {
        me: { id: '10', name: 'Charlie' },
        boards: Array.from({ length: 25 }, (_, i) => board(String(i + 1), i === 0 ? [{ id: 'owner', type: 'people' }] : []))
      }
    }
    if (named(call, 'GetMoreActiveBoards')) return { boards: [board('26', [{ id: 'lead', type: 'people' }])] }
    if (named(call, 'GetBoardAssignedItems')) {
      const [boardId] = call.variables.ids as string[]
      return boardId === '1'
        ? itemsPage('cursor-page-2', [item('1001', 'First Task', [{ id: 'p', text: 'high', column: { title: 'Priority' } }])])
        : itemsPage(null, [item('2601', 'Twenty-sixth Task')])
    }
    return { next_items_page: { cursor: null, items: [item('1002', 'Second Task')] } }
  })

  const result = await readAssignedTasks('paginated.monday.com', graphql)

  assert.deepEqual(
    calls.filter((call) => named(call, 'GetMoreActiveBoards')).map((call) => call.variables),
    [{ page: 2 }]
  )
  assert.deepEqual(
    calls.filter((call) => named(call, 'GetNextAssignedItems')).map((call) => call.variables),
    [{ cursor: 'cursor-page-2' }]
  )
  assert.deepEqual(result.tasks.map((task) => task.sourceUrl), [
    'https://paginated.monday.com/boards/1/pulses/1001',
    'https://paginated.monday.com/boards/1/pulses/1002',
    'https://paginated.monday.com/boards/26/pulses/2601'
  ])
  assert.equal(result.tasks[0].fields.Priority, 'high')
  assert.equal(result.complete, true)
})

test('deduplicates tasks by board and item across pages', async () => {
  const { graphql } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return { me: { id: '5', name: 'Dave' }, boards: [board('1', people)] }
    }
    if (named(call, 'GetBoardAssignedItems')) return itemsPage('c1', [item('7')])
    return { next_items_page: { cursor: null, items: [item('7'), item('8')] } }
  })

  const result = await readAssignedTasks('dedup.monday.com', graphql)
  assert.deepEqual(result.tasks.map((task) => task.itemId), ['7', '8'])
  assert.equal(result.complete, true)
})

test('a repeated cursor stops the board and marks the result incomplete', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return { me: { id: '1', name: 'User' }, boards: [board('1', people)] }
    }
    if (named(call, 'GetBoardAssignedItems')) return itemsPage('stuck-cursor', [item('11')])
    return { next_items_page: { cursor: 'stuck-cursor', items: [item('12')] } }
  })

  const result = await readAssignedTasks('loop.monday.com', graphql)
  assert.equal(calls.filter((call) => named(call, 'GetNextAssignedItems')).length, 1)
  assert.deepEqual(result.tasks.map((task) => task.itemId), ['11', '12'])
  assert.equal(result.complete, false)
  assert.ok(result.warnings.some((w) => w.includes('Repeated cursor detected')))
})

test('a failing or malformed board becomes a warning and the read continues', async () => {
  const { graphql } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return {
        me: { id: '1', name: 'User' },
        boards: [board('1', people), board('2', people), board('3', people)]
      }
    }
    const [boardId] = call.variables.ids as string[]
    if (boardId === '1') throw new Error('Permission denied on board')
    if (boardId === '2') return { boards: [{ items_page: { cursor: null, items: 'not a list' } }] }
    return itemsPage(null, [item('31', 'Good Item')])
  })

  const result = await readAssignedTasks('resilient.monday.com', graphql)
  assert.equal(result.complete, false)
  assert.deepEqual(result.tasks.map((task) => task.itemId), ['31'])
  assert.equal(result.warnings.length, 2)
  assert.ok(result.warnings[0].includes('Permission denied on board'))
  assert.ok(result.warnings[1].includes('unexpected items page'))
})

test('items with a non-numeric ID are skipped with a warning', async () => {
  const { graphql } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return { me: { id: '1', name: 'User' }, boards: [board('1', people)] }
    }
    return itemsPage(null, [item('../../evil'), item('42')])
  })

  const result = await readAssignedTasks('strict.monday.com', graphql)
  assert.deepEqual(result.tasks.map((task) => task.itemId), ['42'])
  assert.equal(result.complete, false)
})

test('enforces maxTasks and reports truncation', async () => {
  const { graphql } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return { me: { id: '1', name: 'User' }, boards: [board('1', people)] }
    }
    return itemsPage(null, [item('1'), item('2'), item('3')])
  })

  const result = await readAssignedTasks('cap.monday.com', graphql, { maxTasks: 2 })
  assert.equal(result.tasks.length, 2)
  assert.equal(result.complete, false)
  assert.ok(result.warnings.some((w) => w.includes('Stopped at 2 tasks')))
})

test('enforces maxBoards and reports truncation', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return { me: { id: '1', name: 'User' }, boards: [board('1', people), board('2', people), board('3', people)] }
    }
    const [boardId] = call.variables.ids as string[]
    return itemsPage(null, [item(`${boardId}0`)])
  })

  const result = await readAssignedTasks('boards.monday.com', graphql, { maxBoards: 2 })
  assert.equal(calls.filter((call) => named(call, 'GetBoardAssignedItems')).length, 2)
  assert.deepEqual(result.tasks.map((task) => task.boardId), ['1', '2'])
  assert.equal(result.complete, false)
  assert.ok(result.warnings.some((w) => w.includes('first 2 active boards')))
})

test('stops at the deadline and reports it', async () => {
  const { graphql, calls } = fakeGraphql(async (call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      await sleep(20)
      return { me: { id: '1', name: 'User' }, boards: [board('1', people)] }
    }
    return itemsPage(null, [item('1')])
  })

  const result = await readAssignedTasks('slow.monday.com', graphql, { deadlineMs: 5 })
  assert.equal(calls.length, 1)
  assert.deepEqual(result.tasks, [])
  assert.equal(result.complete, false)
  assert.ok(result.warnings.some((w) => w.includes('5 ms time limit')))
})

test('reads each item group and its typed column values with status colours, in board order', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) return { me: { id: '1', name: 'Ada' }, boards: [board('10', people)] }
    return itemsPage(null, [{
      id: '100',
      name: 'Login form',
      group: { id: 'topics', title: 'This week', color: '#FDAB3D' },
      column_values: [
        { id: 'status', type: 'status', text: 'Working on it', column: { title: 'Status' }, label_style: { color: '#FDAB3D' } },
        { id: 'person', type: 'people', text: 'Ada Lovelace', column: { title: 'Owner' } },
        { id: 'date4', type: 'date', text: '', column: { title: 'Due' } },
        { id: 'bad id!', type: 'text', text: 'dropped', column: { title: 'Odd' } },
        { id: 'priority', type: 'status', text: 'High', column: { title: 'Priority' }, label_style: { color: 'red' } }
      ]
    }])
  })

  const result = await readAssignedTasks('corp.monday.com', graphql)

  assert.ok(calls.some((call) => call.query.includes('label_style')))
  const [task] = result.tasks
  assert.deepEqual(task?.group, { id: 'topics', title: 'This week', color: '#fdab3d' })
  assert.deepEqual(task?.columns, [
    { id: 'status', title: 'Status', type: 'status', text: 'Working on it', color: '#fdab3d' },
    { id: 'person', title: 'Owner', type: 'people', text: 'Ada Lovelace', color: null },
    // A colour that is not #rrggbb is never passed on.
    { id: 'priority', title: 'Priority', type: 'status', text: 'High', color: null }
  ])
  // The fields the draft reads stay as they were.
  assert.equal(task?.fields['Status'], 'Working on it')
})

test('falls back to the plain item query for good once monday refuses the board-view fields', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignedTasksData')) {
      return { me: { id: '1', name: 'Ada' }, boards: [board('10', people), board('20', people)] }
    }
    if (call.query.includes('label_style')) throw new Error('monday API: Cannot query field "label_style" on type "StatusValue"')
    const [id] = call.variables.ids as string[]
    return itemsPage(null, [item(`${id}1`)])
  })

  const result = await readAssignedTasks('corp.monday.com', graphql)

  assert.deepEqual(result.tasks.map((task) => task.itemId), ['101', '201'])
  assert.ok(result.tasks.every((task) => !('columns' in task) && !('group' in task)))
  assert.equal(result.complete, true)
  assert.deepEqual(result.warnings, [])
  assert.equal(calls.filter((call) => call.query.includes('label_style')).length, 1)
})

test('lists the boards the user can be assigned on, with their workspace, and reads no item', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'InitialAssignableBoards')) {
      return {
        me: { id: '1', name: 'Ada' },
        boards: [
          { id: '10', name: 'Web', type: 'board', workspace: { name: 'Engineering' }, columns: people },
          { id: '20', name: 'Notes', type: 'board', workspace: { name: 'Engineering' }, columns: [{ id: 'text', type: 'text' }] },
          // The hidden board that holds Web's subitems, and a doc: neither is a board to pick
          { id: '11', name: 'Subitems of Web', type: 'sub_items_board', workspace: { name: 'Engineering' }, columns: people },
          { id: '12', name: 'Plan', type: 'document', workspace: { name: 'Engineering' }, columns: people },
          // An answer without a type is still offered
          { id: '30', name: 'Ops', workspace: null, columns: people }
        ]
      }
    }
    throw new Error(`unexpected query ${call.query}`)
  })

  const result = await readAssignedTasks('corp.monday.com', graphql, { boardsOnly: true })

  assert.deepEqual(result.boards, [
    { id: '10', name: 'Web', workspace: 'Engineering' },
    { id: '30', name: 'Ops', workspace: null }
  ])
  assert.deepEqual(result.tasks, [])
  assert.equal(result.complete, true)
  assert.equal(calls.length, 1)
})

test('reads only the chosen boards, in one board query, never listing the others', async () => {
  const { graphql, calls } = fakeGraphql((call) => {
    if (named(call, 'GetChosenBoards')) {
      assert.deepEqual(call.variables, { ids: ['20'] })
      return { me: { id: '1', name: 'Ada' }, boards: [board('20', people)] }
    }
    if (named(call, 'GetBoardAssignedItems')) return itemsPage(null, [item('201')])
    throw new Error(`unexpected query ${call.query}`)
  })

  const result = await readAssignedTasks('corp.monday.com', graphql, { boardIds: ['20'] })

  assert.deepEqual(result.tasks.map((task) => `${task.boardId}:${task.itemId}`), ['20:201'])
  assert.equal(result.boards, undefined)
  assert.ok(calls.every((call) => !named(call, 'InitialAssignedTasksData') && !named(call, 'GetMoreActiveBoards')))
})

test('rejects a board choice it cannot read', async () => {
  const { graphql, calls } = fakeGraphql(() => ({}))

  await assert.rejects(readAssignedTasks('corp.monday.com', graphql, { boardIds: ['12a'] }), /numeric monday board ids/)
  await assert.rejects(
    readAssignedTasks('corp.monday.com', graphql, { boardIds: Array.from({ length: 51 }, (_, index) => String(index + 1)) }),
    /at most 50 boards/
  )
  await assert.rejects(readAssignedTasks('corp.monday.com', graphql, { boardsOnly: true, boardIds: ['1'] }), /cannot be combined/)
  assert.equal(calls.length, 0)
})
