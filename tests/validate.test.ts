import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTaskUrl } from '../bridge/validate.js'

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
