import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PairingManager } from '../bridge/pairing.js'

test('pairing requires the secret and delivers the approved token once', () => {
  const pairing = new PairingManager()
  const { pairId, code } = pairing.createRequest('a-secret-only-the-extension-knows')

  assert.match(code, /^\d{6}$/)
  assert.equal(pairing.poll(pairId, 'wrong-secret'), null)
  assert.deepEqual(pairing.poll(pairId, 'a-secret-only-the-extension-knows'), { status: 'pending' })
  assert.deepEqual(pairing.approveByCode(code, 'bridge-token'), { pairId })
  assert.deepEqual(pairing.poll(pairId, 'a-secret-only-the-extension-knows'), {
    status: 'approved', token: 'bridge-token'
  })
  assert.equal(pairing.poll(pairId, 'a-secret-only-the-extension-knows'), null)
  assert.equal(pairing.approveByCode(code, 'other-token'), null)
})
