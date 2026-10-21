/**
 * @fileoverview Integration tests for the admin publishing controls, run
 * against a real in-memory SQLite database so the correlated EXISTS
 * subqueries, the left join and the LIKE escaping are actually executed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { listingControls, polymarketMarkets } from '@/packages/investing/src/db/schema'
import type { AdminDB } from '../db'
import {
  MAX_BULK_IDS,
  PM_MARKET_KIND,
  STOCK_KIND,
  deleteStockControl,
  filterHiddenQuotes,
  getFeaturedStocks,
  getHiddenStockSymbols,
  getHiddenStockSymbolsSafe,
  listMarketCategories,
  listMarketsForAdmin,
  listStockControls,
  listingId,
  normalizeSymbol,
  setAllMarketsPublished,
  setMarketsPublished,
  upsertStockControl,
} from '../listings'

function createTableSql(table: SQLiteTable): string {
  const config = getTableConfig(table)
  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}"`, column.getSQLType()]
    if (column.primary) parts.push('primary key')
    else if (column.notNull) parts.push('not null')
    return parts.join(' ')
  })
  return `create table "${config.name}" (${columns.join(', ')})`
}

const T0 = new Date('2026-01-01T00:00:00.000Z')
const T1 = new Date('2026-02-01T00:00:00.000Z')

let db: AdminDB

function market(id: string, overrides: Partial<typeof polymarketMarkets.$inferInsert> = {}) {
  return {
    id,
    question: `Will ${id} happen?`,
    slug: `will-${id}-happen`,
    outcomes: '["Yes","No"]',
    outcomePrices: '["0.5","0.5"]',
    active: true,
    closed: false,
    volume24hr: 0,
    volumeTotal: 0,
    category: 'Politics',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

async function seedMarkets() {
  await db.insert(polymarketMarkets).values([
    market('m1', { volume24hr: 300, volumeTotal: 10, endDate: '2026-12-01T00:00:00Z' }),
    market('m2', { volume24hr: 200, volumeTotal: 30, category: 'Sports', endDate: '2026-06-01T00:00:00Z' }),
    market('m3', { volume24hr: 100, volumeTotal: 20, question: 'Will 100% of votes be counted?', active: false }),
    market('m4', { volume24hr: 50, volumeTotal: 5, category: 'Crypto', question: 'BTC_above 100k?' }),
  ])
}

beforeEach(async () => {
  const client = createClient({ url: ':memory:' })
  for (const table of [polymarketMarkets, listingControls]) {
    await client.execute(createTableSql(table))
  }
  db = drizzle(client) as unknown as AdminDB
})

describe('listingId / normalizeSymbol', () => {
  it('prefixes the kind', () => {
    expect(listingId(PM_MARKET_KIND, 'abc')).toBe('pm-market:abc')
    expect(listingId(STOCK_KIND, 'AAPL')).toBe('stock:AAPL')
  })

  it.each([
    ['aapl', 'AAPL'],
    ['  msft ', 'MSFT'],
    ['brk.b', 'BRK.B'],
    ['^gspc', '^GSPC'],
    ['eurusd=x', 'EURUSD=X'],
    ['bf-b', 'BF-B'],
  ])('normalizes %s to %s', (raw, expected) => {
    expect(normalizeSymbol(raw)).toBe(expected)
  })

  it.each([[''], ['   '], ['AAPL; drop table'], ['A'.repeat(16)], [null], [undefined], [42], ['ÄPPL']])(
    'rejects %p',
    (raw) => {
      expect(normalizeSymbol(raw)).toBeNull()
    },
  )
})

describe('listMarketsForAdmin', () => {
  beforeEach(seedMarkets)

  it('lists every market as published when no decision exists', async () => {
    const result = await listMarketsForAdmin(db)
    expect(result.markets.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(result.markets.every((m) => m.published)).toBe(true)
    expect(result.counts).toEqual({ total: 4, published: 4, unpublished: 0 })
    expect(result.matched).toBe(4)
    expect(result.pageCount).toBe(1)
  })

  it('reflects unpublished markets and filters by status', async () => {
    await setMarketsPublished(db, ['m2'], false, 'admin@example.com', T1)

    const all = await listMarketsForAdmin(db)
    const m2 = all.markets.find((m) => m.id === 'm2')!
    expect(m2.published).toBe(false)
    expect(m2.controlUpdatedBy).toBe('admin@example.com')
    expect(all.counts).toEqual({ total: 4, published: 3, unpublished: 1 })

    const unpublished = await listMarketsForAdmin(db, { status: 'unpublished' })
    expect(unpublished.markets.map((m) => m.id)).toEqual(['m2'])
    expect(unpublished.matched).toBe(1)

    const published = await listMarketsForAdmin(db, { status: 'published' })
    expect(published.markets.map((m) => m.id)).toEqual(['m1', 'm3', 'm4'])
  })

  it('treats an explicitly re-published market as published', async () => {
    await setMarketsPublished(db, ['m1'], false, null, T0)
    await setMarketsPublished(db, ['m1'], true, null, T1)
    const { markets, counts } = await listMarketsForAdmin(db, { status: 'published' })
    expect(markets.map((m) => m.id)).toContain('m1')
    expect(counts.unpublished).toBe(0)
  })

  it('searches the question, slug and exact id', async () => {
    expect((await listMarketsForAdmin(db, { q: 'm2' })).markets.map((m) => m.id)).toEqual(['m2'])
    expect((await listMarketsForAdmin(db, { q: 'will-m4' })).markets.map((m) => m.id)).toEqual(['m4'])
  })

  it('escapes LIKE wildcards in the search', async () => {
    // "100%" must match the literal percent sign, not "100" followed by anything.
    expect((await listMarketsForAdmin(db, { q: '100%' })).markets.map((m) => m.id)).toEqual(['m3'])
    // "_" must be literal too: only m4's question has "BTC_above".
    expect((await listMarketsForAdmin(db, { q: 'C_a' })).markets.map((m) => m.id)).toEqual(['m4'])
  })

  it('filters by category and active flag', async () => {
    expect((await listMarketsForAdmin(db, { category: 'Sports' })).markets.map((m) => m.id)).toEqual(['m2'])
    expect((await listMarketsForAdmin(db, { category: 'all' })).markets).toHaveLength(4)
    expect((await listMarketsForAdmin(db, { activeOnly: true })).markets.map((m) => m.id)).toEqual(['m1', 'm2', 'm4'])
  })

  it('scopes the status counts to the search and category, not the status filter', async () => {
    await setMarketsPublished(db, ['m1', 'm2'], false, null)
    const result = await listMarketsForAdmin(db, { category: 'Politics', status: 'published' })
    expect(result.markets.map((m) => m.id)).toEqual(['m3'])
    expect(result.counts).toEqual({ total: 2, published: 1, unpublished: 1 })
  })

  it('sorts by the requested column', async () => {
    expect((await listMarketsForAdmin(db, { sort: 'volumeTotal' })).markets.map((m) => m.id)).toEqual(['m2', 'm3', 'm1', 'm4'])
    // Ending soonest first; markets without an end date sort first in SQLite's ascending NULL order.
    const byEnd = (await listMarketsForAdmin(db, { sort: 'endDate' })).markets.map((m) => m.id)
    expect(byEnd.indexOf('m2')).toBeLessThan(byEnd.indexOf('m1'))
  })

  it('paginates and clamps the page size', async () => {
    const page2 = await listMarketsForAdmin(db, { limit: 3, page: 2 })
    expect(page2.markets.map((m) => m.id)).toEqual(['m4'])
    expect(page2.pageCount).toBe(2)
    expect(page2.limit).toBe(3)

    expect((await listMarketsForAdmin(db, { limit: 0 })).limit).toBe(1)
    expect((await listMarketsForAdmin(db, { limit: 10_000 })).limit).toBe(100)
    expect((await listMarketsForAdmin(db, { page: -4 })).page).toBe(1)
  })

  it('reports an empty table', async () => {
    await db.delete(polymarketMarkets)
    const result = await listMarketsForAdmin(db)
    expect(result.markets).toEqual([])
    expect(result.counts).toEqual({ total: 0, published: 0, unpublished: 0 })
    expect(result.pageCount).toBe(1)
  })
})

describe('listMarketCategories', () => {
  it('returns the distinct non-empty categories, sorted', async () => {
    await seedMarkets()
    await db.insert(polymarketMarkets).values(market('m5', { category: null }))
    expect(await listMarketCategories(db)).toEqual(['Crypto', 'Politics', 'Sports'])
  })
})

describe('setMarketsPublished', () => {
  beforeEach(seedMarkets)

  it('writes one control row per market, labelled with the question', async () => {
    const result = await setMarketsPublished(db, ['m1', 'm2'], false, 'a@x.com', T1)
    expect(result).toEqual({ updated: ['m1', 'm2'], missing: [] })

    const rows = await db.select().from(listingControls)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: 'pm-market:m1',
      kind: 'pm-market',
      itemId: 'm1',
      published: false,
      label: 'Will m1 happen?',
      updatedBy: 'a@x.com',
    })
  })

  it('reports ids that are not markets instead of creating rows for them', async () => {
    const result = await setMarketsPublished(db, ['m1', 'ghost'], false, null)
    expect(result).toEqual({ updated: ['m1'], missing: ['ghost'] })
    expect(await db.select().from(listingControls)).toHaveLength(1)
  })

  it('de-duplicates and ignores empty ids', async () => {
    const result = await setMarketsPublished(db, ['m1', 'm1', ''], true, null)
    expect(result.updated).toEqual(['m1'])
  })

  it('does nothing for an empty list', async () => {
    expect(await setMarketsPublished(db, [], true, null)).toEqual({ updated: [], missing: [] })
  })

  it('updates in place, keeping the original creation time', async () => {
    await setMarketsPublished(db, ['m1'], false, 'first@x.com', T0)
    await setMarketsPublished(db, ['m1'], true, 'second@x.com', T1)
    const [row] = await db.select().from(listingControls)
    expect(row.published).toBe(true)
    expect(row.updatedBy).toBe('second@x.com')
    expect(row.createdAt.getTime()).toBe(T0.getTime())
    expect(row.updatedAt.getTime()).toBe(T1.getTime())
  })

  it('exposes a bulk cap the route enforces', () => {
    expect(MAX_BULK_IDS).toBeGreaterThan(0)
  })
})

describe('setAllMarketsPublished', () => {
  beforeEach(seedMarkets)

  it('applies to every market', async () => {
    expect(await setAllMarketsPublished(db, false, null)).toBe(4)
    expect((await listMarketsForAdmin(db)).counts.unpublished).toBe(4)
  })

  it('can be scoped to one category', async () => {
    expect(await setAllMarketsPublished(db, false, null, { category: 'Politics' })).toBe(2)
    const { counts } = await listMarketsForAdmin(db)
    expect(counts).toEqual({ total: 4, published: 2, unpublished: 2 })
  })

  it('treats category "all" as no filter', async () => {
    expect(await setAllMarketsPublished(db, true, null, { category: 'all' })).toBe(4)
  })
})

describe('stock controls', () => {
  it('features and hides stocks, normalizing the symbol', async () => {
    const saved = await upsertStockControl(db, { symbol: 'aapl', published: true, label: 'Apple' }, 'a@x.com', T0)
    expect(saved).toMatchObject({ symbol: 'AAPL', published: true, label: 'Apple', updatedBy: 'a@x.com' })
    await upsertStockControl(db, { symbol: 'TSLA', published: false }, null, T0)

    expect(await getFeaturedStocks(db)).toEqual([{ symbol: 'AAPL', label: 'Apple' }])
    expect([...(await getHiddenStockSymbols(db))]).toEqual(['TSLA'])
  })

  it('lists featured stocks before hidden ones, alphabetically', async () => {
    await upsertStockControl(db, { symbol: 'ZM', published: false }, null)
    await upsertStockControl(db, { symbol: 'MSFT', published: true }, null)
    await upsertStockControl(db, { symbol: 'AAPL', published: true }, null)
    expect((await listStockControls(db)).map((s) => `${s.symbol}:${s.published}`)).toEqual([
      'AAPL:true',
      'MSFT:true',
      'ZM:false',
    ])
  })

  it('keeps the label and note when a later toggle omits them', async () => {
    await upsertStockControl(db, { symbol: 'NVDA', published: true, label: 'Nvidia', note: 'AI pick' }, null)
    const toggled = await upsertStockControl(db, { symbol: 'NVDA', published: false }, null)
    expect(toggled).toMatchObject({ published: false, label: 'Nvidia', note: 'AI pick' })
  })

  it('clears a label when null is passed explicitly', async () => {
    await upsertStockControl(db, { symbol: 'NVDA', published: true, label: 'Nvidia' }, null)
    const cleared = await upsertStockControl(db, { symbol: 'NVDA', published: true, label: null }, null)
    expect(cleared.label).toBeNull()
  })

  it('rejects an invalid symbol', async () => {
    await expect(upsertStockControl(db, { symbol: 'bad symbol!', published: true }, null)).rejects.toThrow(
      'Invalid symbol',
    )
  })

  it('does not leak into the market controls', async () => {
    await seedMarkets()
    await upsertStockControl(db, { symbol: 'M1', published: false }, null)
    expect((await listMarketsForAdmin(db)).counts.unpublished).toBe(0)
  })

  it('deletes a decision', async () => {
    await upsertStockControl(db, { symbol: 'AAPL', published: true }, null)
    expect(await deleteStockControl(db, 'aapl')).toBe(true)
    expect(await deleteStockControl(db, 'AAPL')).toBe(false)
    expect(await deleteStockControl(db, '!!')).toBe(false)
    expect(await listStockControls(db)).toEqual([])
  })
})

describe('filterHiddenQuotes', () => {
  const quotes = [{ symbol: 'AAPL' }, { symbol: 'tsla' }, { symbol: 'MSFT' }, { name: 'no symbol' }]

  it('drops hidden symbols case-insensitively and keeps rows without one', () => {
    expect(filterHiddenQuotes(quotes, new Set(['TSLA', 'MSFT']))).toEqual([{ symbol: 'AAPL' }, { name: 'no symbol' }])
  })

  it('returns the input untouched when nothing is hidden', () => {
    expect(filterHiddenQuotes(quotes, new Set())).toBe(quotes)
  })

  it('treats a missing quote list as empty', () => {
    expect(filterHiddenQuotes(undefined, new Set(['A']))).toEqual([])
    expect(filterHiddenQuotes(null, new Set())).toEqual([])
  })
})

describe('getHiddenStockSymbolsSafe', () => {
  it('returns the hidden symbols', async () => {
    await upsertStockControl(db, { symbol: 'GME', published: false }, null)
    expect([...(await getHiddenStockSymbolsSafe(() => db))]).toEqual(['GME'])
  })

  it('hides nothing when the database is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = () => {
      throw new Error('No Cloudflare D1 connection available')
    }
    expect((await getHiddenStockSymbolsSafe(broken)).size).toBe(0)
  })

  it('hides nothing when the table is missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const empty = drizzle(createClient({ url: ':memory:' })) as unknown as AdminDB
    expect((await getHiddenStockSymbolsSafe(() => empty)).size).toBe(0)
  })
})
