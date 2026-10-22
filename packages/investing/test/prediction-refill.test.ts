/**
 * @fileoverview refillMarkets: the non-destructive admin refill. Upserts via
 * the incremental sync, then retires markets whose end date has passed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'

const syncMarketsIncremental = vi.hoisted(() => vi.fn())
const updates = vi.hoisted(() => ({ calls: [] as Array<{ set: unknown; where: unknown }>, returned: [] as unknown[] }))

vi.mock('../src/prediction/sync/incremental-markets', () => ({ syncMarketsIncremental }))
vi.mock('../src/db', () => ({
  db: {
    update: () => {
      const call: { set: unknown; where: unknown } = { set: undefined, where: undefined }
      updates.calls.push(call)
      const chain = {
        set(value: unknown) {
          call.set = value
          return chain
        },
        where(value: unknown) {
          call.where = value
          return chain
        },
        returning: async () => updates.returned,
      }
      return chain
    },
  },
}))

import {
  MAX_REFILL_MARKETS,
  clampRefillSize,
  deactivateExpiredMarkets,
  refillMarkets,
} from '../src/prediction/sync/refill'

const NOW = new Date('2026-10-12T00:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
  updates.calls = []
  updates.returned = []
  syncMarketsIncremental.mockResolvedValue({ markets: 42, pricePoints: 7, holders: 3 })
})

describe('clampRefillSize', () => {
  it.each([
    [100, 100],
    ['250', 250],
    [12.9, 12],
    [MAX_REFILL_MARKETS + 1, MAX_REFILL_MARKETS],
    [0, 500],
    [-5, 500],
    ['lots', 500],
    [undefined, 500],
    [null, 500],
    [Number.POSITIVE_INFINITY, 500],
  ])('clamps %p to %p', (input, expected) => {
    expect(clampRefillSize(input)).toBe(expected)
  })

  it('uses the given fallback', () => {
    expect(clampRefillSize(undefined, 50)).toBe(50)
  })
})

describe('deactivateExpiredMarkets', () => {
  it('marks active markets that ended before now as inactive', async () => {
    updates.returned = [{ id: 'a' }, { id: 'b' }]
    expect(await deactivateExpiredMarkets(NOW)).toBe(2)

    const [{ set, where }] = updates.calls
    expect(set).toEqual({ active: false, updatedAt: NOW })
    const query = new SQLiteSyncDialect().sqlToQuery(where as never)
    expect(query.sql).toContain('"active" = ?')
    expect(query.sql).toContain('"end_date" is not null')
    expect(query.sql).toContain('"end_date" < ?')
    expect(query.params).toContain(NOW.toISOString())
  })
})

describe('refillMarkets', () => {
  it('syncs 500 markets without price history or holders by default, then retires ended ones', async () => {
    updates.returned = [{ id: 'old' }]
    const result = await refillMarkets({ now: NOW })
    expect(syncMarketsIncremental).toHaveBeenCalledWith(500, false, false)
    expect(result).toEqual({ markets: 42, pricePoints: 7, holders: 3, deactivated: 1 })
  })

  it('passes the options through and clamps the size', async () => {
    await refillMarkets({ maxMarkets: 1e9, priceHistory: true, holders: true, now: NOW })
    expect(syncMarketsIncremental).toHaveBeenCalledWith(MAX_REFILL_MARKETS, true, true)
  })

  it('can skip retiring ended markets', async () => {
    const result = await refillMarkets({ deactivateExpired: false })
    expect(updates.calls).toHaveLength(0)
    expect(result.deactivated).toBe(0)
  })

  it('defaults missing counters to zero', async () => {
    syncMarketsIncremental.mockResolvedValue({ markets: 5 })
    expect(await refillMarkets({ deactivateExpired: false })).toEqual({
      markets: 5,
      pricePoints: 0,
      holders: 0,
      deactivated: 0,
    })
  })

  it('propagates a sync failure without touching the table', async () => {
    syncMarketsIncremental.mockRejectedValue(new Error('Polymarket API returned 503'))
    await expect(refillMarkets()).rejects.toThrow('503')
    expect(updates.calls).toHaveLength(0)
  })
})
