import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapItem, OTHER_FILES_FIELD, UPDATE_LIMIT } from '../extension/helpers/monday-api.js'

test('mapItem turns a GraphQL item into snapshot fields, updates and image attachments', () => {
  const task = mapItem({
    id: '13168350030',
    name: 'FS-008: Scoreboard',
    column_values: [
      { id: 'person', type: 'people', text: 'Claire', column: { title: 'Owner' } },
      { id: 'color_mkwsbf46', type: 'status', text: 'Done to check', column: { title: 'API Status' } },
      { id: 'date0', type: 'date', text: '', column: { title: 'ESTIMATE' } },
      { id: 'notes', type: 'text', text: null, column: null }
    ],
    updates: [
      {
        id: 1,
        text_body: ' Please check the score layout. ',
        created_at: '2026-10-08T09:00:00Z',
        creator: { name: 'Claire' },
        replies: [{ id: 2, text_body: 'Done', created_at: '2026-10-08T10:00:00Z', creator: { name: 'Nathan' } }],
        assets: [
          { id: 10, name: 'score.png', file_extension: '.PNG', public_url: 'https://files.example/score.png', url: 'https://team.monday.com/protected_static/score.png' },
          { id: 11, name: 'spec.pdf', file_extension: 'pdf', public_url: 'https://files.example/spec.pdf' }
        ]
      }
    ],
    // The same image is attached to the item too
    assets: [{ id: 10, name: 'score.png', file_extension: 'png', public_url: 'https://files.example/score.png' }]
  })

  assert.equal(task.title, 'FS-008: Scoreboard')
  assert.deepEqual(task.fields, { Owner: 'Claire', 'API Status': 'Done to check', [OTHER_FILES_FIELD]: 'spec.pdf' })
  assert.deepEqual(task.updates, [{
    id: '1', author: 'Claire', createdAt: '2026-10-08T09:00:00Z', body: 'Please check the score layout.',
    replies: [{ id: '2', author: 'Nathan', createdAt: '2026-10-08T10:00:00Z', body: 'Done' }]
  }])
  assert.deepEqual(task.attachments, [{ id: '10', name: 'score.png', mimeType: 'image/png', url: 'https://files.example/score.png' }])
  assert.deepEqual(task.warnings, [])
})

test('mapItem warns when the update limit may have cut older updates', () => {
  const updates = Array.from({ length: UPDATE_LIMIT }, (_, i) => ({ id: i, text_body: `u${i}` }))
  const task = mapItem({ id: 1, name: 'Busy task', updates })
  assert.equal(task.updates.length, UPDATE_LIMIT)
  assert.deepEqual(task.warnings, [`Only the latest ${UPDATE_LIMIT} updates were read`])
})
