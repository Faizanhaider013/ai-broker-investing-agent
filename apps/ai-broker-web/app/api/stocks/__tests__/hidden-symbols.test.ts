/**
 * @fileoverview The public stock lists (trending, daily gainers, screener)
 * drop the symbols an admin hid, and keep working when that lookup fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const trendingSymbols = vi.hoisted(() => vi.fn())
const screener = vi.hoisted(() => vi.fn())
const getHiddenStockSymbols = vi.hoisted(() => vi.fn())

vi.mock('@/packages/investing/src/stocks/yahoo-finance-wrapper', () => ({
  createYahooFinance: () => ({ trendingSymbols, screener }),
}))
vi.mock('@/lib/admin/db', () => ({ getAdminDB: vi.fn(() => 'db') }))
vi.mock('@/lib/admin/listings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/listings')>()
  return {
    ...actual,
    // Route the safe wrapper through the mock so a rejection exercises its fallback.
    getHiddenStockSymbolsSafe: async (db: () => unknown) => {
      try {
        return await getHiddenStockSymbols(db())
      } catch {
        return new Set<string>()
      }
    },
  }
})

import { GET as trending } from '../trending/route'
import { GET as gainers } from '../gainers/route'
import { GET as screenerRoute } from '../screener/route'

const QUOTES = [{ symbol: 'AAPL' }, { symbol: 'GME' }, { symbol: 'NVDA' }]

beforeEach(() => {
  vi.clearAllMocks()
  trendingSymbols.mockResolvedValue({ quotes: QUOTES })
  screener.mockResolvedValue({ quotes: QUOTES })
  getHiddenStockSymbols.mockResolvedValue(new Set(['GME']))
})

describe.each([
  ['trending', () => trending(new NextRequest('http://localhost/api/stocks/trending'))],
  ['gainers', () => gainers(new NextRequest('http://localhost/api/stocks/gainers?count=5'))],
  ['screener', () => screenerRoute(new NextRequest('http://localhost/api/stocks/screener?scrIds=most_actives'))],
])('GET /api/stocks/%s', (_name, call) => {
  it('drops hidden symbols and counts what is left', async () => {
    const body = await (await call()).json()
    expect(body.success).toBe(true)
    expect(body.data).toEqual([{ symbol: 'AAPL' }, { symbol: 'NVDA' }])
    expect(body.count).toBe(2)
  })

  it('serves the full list when the hidden lookup fails', async () => {
    getHiddenStockSymbols.mockRejectedValue(new Error('no such table: listing_controls'))
    const body = await (await call()).json()
    expect(body.data).toEqual(QUOTES)
    expect(body.count).toBe(3)
  })

  it('handles an upstream response with no quotes', async () => {
    trendingSymbols.mockResolvedValue({})
    screener.mockResolvedValue({})
    const body = await (await call()).json()
    expect(body.data).toEqual([])
    expect(body.count).toBe(0)
  })
})
