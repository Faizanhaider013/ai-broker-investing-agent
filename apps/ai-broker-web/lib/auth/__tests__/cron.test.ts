/**
 * @fileoverview The CRON_SECRET bearer check used by the scheduled routes.
 * The secret must come from the Worker env (via serverEnv), and an unset
 * secret must never match — otherwise "Bearer undefined" would open the
 * cron routes to anyone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/env/runtime', () => ({ serverEnv: vi.fn() }))

import { serverEnv } from '@/lib/env/runtime'
import { isCronRequest } from '../cron'

const mockServerEnv = serverEnv as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  mockServerEnv.mockReturnValue(undefined)
})

describe('isCronRequest', () => {
  it('accepts the bearer token read from the Worker env', () => {
    mockServerEnv.mockImplementation((name: string) => (name === 'CRON_SECRET' ? 's3cret' : undefined))
    expect(isCronRequest('Bearer s3cret')).toBe(true)
    expect(mockServerEnv).toHaveBeenCalledWith('CRON_SECRET')
  })

  it('rejects a wrong token', () => {
    expect(isCronRequest('Bearer nope', 's3cret')).toBe(false)
  })

  it('rejects a token that is a prefix or extension of the secret', () => {
    expect(isCronRequest('Bearer s3cre', 's3cret')).toBe(false)
    expect(isCronRequest('Bearer s3cretX', 's3cret')).toBe(false)
  })

  it('requires the Bearer scheme', () => {
    expect(isCronRequest('s3cret', 's3cret')).toBe(false)
    expect(isCronRequest('bearer s3cret', 's3cret')).toBe(false)
  })

  it('never matches when no secret is configured', () => {
    expect(isCronRequest('Bearer undefined')).toBe(false)
    expect(isCronRequest('Bearer ', '')).toBe(false)
    expect(isCronRequest('Bearer ')).toBe(false)
  })

  it('rejects a missing header', () => {
    expect(isCronRequest(null, 's3cret')).toBe(false)
    expect(isCronRequest(undefined, 's3cret')).toBe(false)
    expect(isCronRequest('', 's3cret')).toBe(false)
  })
})
