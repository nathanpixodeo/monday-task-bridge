import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AssignedTaskSchema, AssignedTasksPayloadSchema, resolveTaskUrl } from '../bridge/validate.js'
import { MAX_TASKS } from '../extension/helpers/assigned-tasks.js'

test('resolveTaskUrl accepts a full task url including a views segment', () => {
  const url = 'https://team.monday.com/boards/123/views/9/pulses/456'
  assert.deepEqual(resolveTaskUrl({ url }, null), { url })
})

test('resolveTaskUrl rejects non-https, foreign hosts and non-task paths', () => {
  assert.ok('error' in resolveTaskUrl({ url: 'http://team.monday.com/boards/1/pulses/2' }, null))
  assert.ok('error' in resolveTaskUrl({ url: 'https://evil.com/x.monday.com/boards/1/pulses/2' }, null))
  assert.ok('error' in resolveTaskUrl({ url: 'https://team.monday.com.evil.com/boards/1/pulses/2' }, null))
  assert.ok('error' in resolveTaskUrl({ url: 'https://team.monday.com/boards/1' }, null))
})

test('resolveTaskUrl builds a url from ids and the account host', () => {
  assert.deepEqual(
    resolveTaskUrl({ boardId: '1', itemId: '2', accountHost: 'acme.monday.com' }, 'team.monday.com'),
    { url: 'https://acme.monday.com/boards/1/pulses/2' }
  )
  assert.deepEqual(
    resolveTaskUrl({ boardId: '1', itemId: '2' }, 'team.monday.com'),
    { url: 'https://team.monday.com/boards/1/pulses/2' }
  )
})

test('resolveTaskUrl errors without a host or without a target', () => {
  assert.ok('error' in resolveTaskUrl({ boardId: '1', itemId: '2' }, null))
  assert.ok('error' in resolveTaskUrl({}, 'team.monday.com'))
})

test('the bridge takes as many assigned tasks as the extension reads, and no more', () => {
  const task = (id: number) => ({
    accountHost: 'corp.monday.com', boardId: '10', boardName: 'Web', itemId: String(id), title: `Task ${id}`,
    sourceUrl: `https://corp.monday.com/boards/10/pulses/${id}`, fields: {}
  })
  const payload = (count: number) => ({
    requestId: 'req-1',
    result: {
      accountHost: 'corp.monday.com', user: { id: '1', name: 'User' },
      tasks: Array.from({ length: count }, (_, index) => task(index + 1)),
      warnings: [], complete: true, checkedAt: '2026-10-15T00:00:00.000Z'
    }
  })
  assert.equal(MAX_TASKS, 5000)
  assert.equal(AssignedTasksPayloadSchema.safeParse(payload(MAX_TASKS)).success, true)
  assert.equal(AssignedTasksPayloadSchema.safeParse(payload(MAX_TASKS + 1)).success, false)
})

test('an assigned task keeps its group and typed columns, and only #rrggbb colours', () => {
  const base = {
    accountHost: 'corp.monday.com', boardId: '10', boardName: 'Web', itemId: '100', title: 'Login',
    sourceUrl: 'https://corp.monday.com/boards/10/pulses/100', fields: { Status: 'Done' }
  }
  const rich = {
    ...base,
    group: { id: 'topics', title: 'This week', color: '#00c875' },
    columns: [{ id: 'status', title: 'Status', type: 'status', text: 'Done', color: '#00c875' }]
  }
  assert.deepEqual(AssignedTaskSchema.parse(rich), rich)
  // A task from an extension older than the board view has neither.
  assert.deepEqual(AssignedTaskSchema.parse(base), base)
  assert.equal(AssignedTaskSchema.safeParse({ ...rich, group: { ...rich.group, color: 'red' } }).success, false)
  assert.equal(AssignedTaskSchema.safeParse({ ...rich, columns: [{ ...rich.columns[0], id: '../x' }] }).success, false)
})
