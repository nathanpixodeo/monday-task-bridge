/**
 * bridge/pairing.ts – pairing flow: 6-digit code, 2-min TTL, single-use.
 */

import { randomInt, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

export interface PairRequest {
  pairId: string
  secret: string
  code: string
  expiresAt: number      // epoch ms
  approved: boolean
  bridgeToken?: string   // set on approval
  consumed: boolean      // token already retrieved
  origin?: string        // bound extension origin
}

const TTL_MS = 2 * 60 * 1000 // 2 minutes
const MAX_PENDING = 3

/**
 * Constant-time comparison for secrets and tokens.
 */
export function safeCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const hashA = createHash('sha256').update(a, 'utf-8').digest()
  const hashB = createHash('sha256').update(b, 'utf-8').digest()
  return timingSafeEqual(hashA, hashB)
}

export class PairingManager {
  private _pending = new Map<string, PairRequest>()

  /**
   * Create a new pairing request.
   * Returns pairId, code, expiresAt (ISO).
   */
  createRequest(secret: string, origin?: string): { pairId: string; code: string; expiresAt: string } {
    this._gc()
    if (this._pending.size >= MAX_PENDING) {
      throw new Error('Too many pending pairing requests')
    }
    const pairId = randomBytes(16).toString('hex')
    let code: string
    do {
      code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    } while ([...this._pending.values()].some(req => req.code === code))
    const expiresAt = Date.now() + TTL_MS

    const req: PairRequest = {
      pairId,
      secret,
      code,
      expiresAt,
      approved: false,
      consumed: false,
      origin,
    }
    this._pending.set(pairId, req)

    return { pairId, code, expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * Look up an unexpired, unapproved request by code without approving it.
   */
  findPendingByCode(code: string): { pairId: string; origin?: string } | null {
    this._gc()
    for (const req of this._pending.values()) {
      if (safeCompare(req.code, code) && !req.approved && !this._isExpired(req)) {
        return { pairId: req.pairId, origin: req.origin }
      }
    }
    return null
  }

  /**
   * Approve a pending request by 6-digit code.
   * Returns pairId (and origin if bound) on success, null if code not found/expired.
   */
  approveByCode(code: string, bridgeToken: string): { pairId: string; origin?: string } | null {
    this._gc()
    for (const req of this._pending.values()) {
      if (safeCompare(req.code, code) && !req.approved && !this._isExpired(req)) {
        req.approved = true
        req.bridgeToken = bridgeToken
        const res: { pairId: string; origin?: string } = { pairId: req.pairId }
        if (req.origin) {
          res.origin = req.origin
        }
        return res
      }
    }
    return null
  }

  /**
   * Poll pairing status. Returns:
   *   - { status: 'pending' } if not yet approved
   *   - { status: 'approved', token } once, then consumed
   *   - null if not found, expired, or already consumed
   */
  poll(pairId: string, secret: string, origin?: string): { status: 'pending' } | { status: 'approved'; token: string } | null {
    this._gc()
    const req = this._pending.get(pairId)
    if (!req) return null
    if (!safeCompare(req.secret, secret)) return null
    // Chromium can omit Origin on a GET from an extension service worker.
    // The request still requires the high-entropy pairing secret. When Origin
    // is present, it must match the extension that created the request.
    if (req.origin && origin && !safeCompare(req.origin, origin)) return null
    if (this._isExpired(req)) {
      this._pending.delete(pairId)
      return null
    }
    if (req.consumed) return null
    if (!req.approved) return { status: 'pending' }

    // Approved — deliver once
    req.consumed = true
    const token = req.bridgeToken!
    // Schedule cleanup
    setTimeout(() => this._pending.delete(pairId), 5000)
    return { status: 'approved', token }
  }

  private _isExpired(req: PairRequest): boolean {
    return Date.now() > req.expiresAt
  }

  private _gc(): void {
    const now = Date.now()
    for (const [id, req] of this._pending) {
      if (now > req.expiresAt) {
        this._pending.delete(id)
      }
    }
  }
}
