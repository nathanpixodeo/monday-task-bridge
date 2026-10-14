import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Graphql } from '../extension/helpers/assigned-tasks.js'
import { updateBody, writeBackToItem, WriteBackTargetError } from '../extension/helpers/write-back.js'

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

const columns = [
  { id: 'priority', title: 'Priority', type: 'status' },
  { id: 'status_1', title: 'Status', type: 'status' },
  { id: 'person', title: 'Owner', type: 'people' }
]
const itemOn = (boardId: string | number, boardColumns: unknown[] = columns) => ({ items: [{ id: '456', board: { id: boardId, columns: boardColumns } }] })
const request = { accountHost: 'team.monday.com', boardId: '123', itemId: '456', comment: 'Done in Nexkit Hub: Fix the login\nMerge: abc123' }

test('sets the Status column to the label first, then adds the update with the text kept as written', async () => {
  const fake = fakeGraphql({
    WriteBackItem: () => itemOn('123'),
    WriteBackStatus: () => ({ change_simple_column_value: { id: '456' } }),
    WriteBackUpdate: () => ({ create_update: { id: '901' } })
  })

  const result = await writeBackToItem(fake.graphql, { ...request, statusLabel: 'Done' })

  assert.deepEqual(result, { updateId: '901', statusSet: true })
  assert.deepEqual(fake.names(), ['WriteBackItem', 'WriteBackStatus', 'WriteBackUpdate'])
  assert.ok(fake.calls.every((call) => call.host === 'team.monday.com'))
  assert.deepEqual(fake.calls[0].variables, { ids: ['456'] })
  assert.deepEqual(fake.calls[1].variables, { boardId: '123', itemId: '456', columnId: 'status_1', value: 'Done' })
  assert.deepEqual(fake.calls[2].variables, { itemId: '456', body: 'Done in Nexkit Hub: Fix the login<br>Merge: abc123' })
})

test('only adds the update when no label is asked for, and takes the first status column when none is titled Status', async () => {
  const fake = fakeGraphql({
    WriteBackItem: () => itemOn(123, [{ id: 'state', title: 'State', type: 'color' }]),
    WriteBackStatus: () => ({ change_simple_column_value: { id: '456' } }),
    WriteBackUpdate: () => ({ create_update: { id: 902 } })
  })

  assert.deepEqual(await writeBackToItem(fake.graphql, request), { updateId: '902', statusSet: false })
  assert.deepEqual(fake.names(), ['WriteBackItem', 'WriteBackUpdate'])

  await writeBackToItem(fake.graphql, { ...request, statusLabel: 'Done' })
  assert.equal(fake.calls[3].variables.columnId, 'state')
})

test('writes nothing to an item it cannot see, or one on another board', async () => {
  for (const answer of [{ items: [] }, { items: [{ id: '456', board: null }] }, itemOn('999')]) {
    const fake = fakeGraphql({ WriteBackItem: () => answer })
    await assert.rejects(writeBackToItem(fake.graphql, { ...request, statusLabel: 'Done' }), WriteBackTargetError)
    assert.deepEqual(fake.names(), ['WriteBackItem'])
  }
})

test('writes nothing when the status cannot be set, and says what was written when the update fails after it', async () => {
  const noStatus = fakeGraphql({ WriteBackItem: () => itemOn('123', [{ id: 'person', title: 'Owner', type: 'people' }]) })
  await assert.rejects(writeBackToItem(noStatus.graphql, { ...request, statusLabel: 'Done' }), /has no status column/)
  assert.deepEqual(noStatus.names(), ['WriteBackItem'])

  const badLabel = fakeGraphql({
    WriteBackItem: () => itemOn('123'),
    WriteBackStatus: () => { throw new Error("monday API: This status label doesn't exist") }
  })
  await assert.rejects(writeBackToItem(badLabel.graphql, { ...request, statusLabel: 'Shipped' }), /nothing was written: monday API: This status label/)
  assert.deepEqual(badLabel.names(), ['WriteBackItem', 'WriteBackStatus'])

  const updateFails = fakeGraphql({
    WriteBackItem: () => itemOn('123'),
    WriteBackStatus: () => ({ change_simple_column_value: { id: '456' } }),
    WriteBackUpdate: () => { throw new Error('monday API: HTTP 500') }
  })
  await assert.rejects(writeBackToItem(updateFails.graphql, { ...request, statusLabel: 'Done' }), /Set the status to "Done", but could not add the update/)
})

test('escapes the text of an update for monday, keeping its lines', () => {
  assert.equal(updateBody('a <b> & c\r\nnext'), 'a &lt;b&gt; &amp; c<br>next')
})
