/**
 * @fileoverview Integration tests for the admin top-traders list, run against
 * a real in-memory SQLite database so each source's ORDER BY is executed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { nvstlyLeaders, polymarketLeaders, zuluTraders } from '@/lib/db/schema'
import type { AdminDB } from '../db'
import {
  MAX_TRADERS,
  TRADER_SORTS,
  TRADER_SOURCES,
  countTradersBySource,
  isTraderSort,
  isTraderSource,
  loadTopTraders,
  toPercent,
} from '../traders'

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

let db: AdminDB
const SYNCED = new Date('2026-03-01T00:00:00.000Z')

beforeEach(async () => {
  const client = createClient({ url: ':memory:' })
  for (const table of [polymarketLeaders, zuluTraders, nvstlyLeaders]) {
    await client.execute(createTableSql(table))
  }
  db = drizzle(client) as unknown as AdminDB
})

describe('guards', () => {
  it('recognizes the sources and sorts', () => {
    for (const s of TRADER_SOURCES) expect(isTraderSource(s)).toBe(true)
    for (const s of TRADER_SORTS) expect(isTraderSort(s)).toBe(true)
    expect(isTraderSource('robinhood')).toBe(false)
    expect(isTraderSource(undefined)).toBe(false)
    expect(isTraderSort('drawdown')).toBe(false)
  })
})

describe('toPercent', () => {
  it.each([
    [0.62, 62],
    [1, 100],
    [0, 0],
    [55.5, 55.5],
    [-0.1, -10],
  ])('maps %p to %p', (input, expected) => {
    expect(toPercent(input)).toBeCloseTo(expected)
  })

  it.each([[null], [undefined], [Number.NaN], [Number.POSITIVE_INFINITY]])('returns null for %p', (input) => {
    expect(toPercent(input as number | null | undefined)).toBeNull()
  })
})

describe('loadTopTraders — polymarket', () => {
  beforeEach(async () => {
    await db.insert(polymarketLeaders).values([
      { trader: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', userName: 'whale', rank: 2, pnl: 500, vol: 9000, winRate: 0.6, profileImage: 'https://img/w.png', updatedAt: SYNCED },
      { trader: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', userName: null, rank: 1, pnl: 900, vol: 100, winRate: 0.4, updatedAt: SYNCED },
      // Only the legacy analytics fields: pnl falls back to overallGain.
      { trader: '0xcccc', userName: 'legacy', rank: null, overallGain: 700, winRate: 71 },
    ])
  })

  it('ranks by PnL by default, falling back to overall gain', async () => {
    const traders = await loadTopTraders(db, { source: 'polymarket' })
    expect(traders.map((t) => t.pnl)).toEqual([900, 700, 500])
    expect(traders.map((t) => t.rank)).toEqual([1, 2, 3])
  })

  it('maps rows into the shared shape', async () => {
    const [top] = await loadTopTraders(db, { source: 'polymarket', sort: 'vol' })
    expect(top).toEqual({
      source: 'polymarket',
      id: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      rank: 1,
      name: 'whale',
      pnl: 500,
      volume: 9000,
      winRate: 60,
      profileUrl: 'https://polymarket.com/profile/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      image: 'https://img/w.png',
      updatedAt: SYNCED,
    })
  })

  it('shortens a wallet address when there is no username', async () => {
    const traders = await loadTopTraders(db, { source: 'polymarket' })
    expect(traders[0].name).toBe('0xbbbb…bbbb')
    // Short ids are shown whole.
    expect(traders.find((t) => t.id === '0xcccc')?.name).toBe('legacy')
  })

  it('sorts by the source rank with unranked traders last', async () => {
    const traders = await loadTopTraders(db, { source: 'polymarket', sort: 'rank' })
    expect(traders.map((t) => t.id)).toEqual([
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '0xcccc',
    ])
  })

  it('sorts by win rate', async () => {
    const traders = await loadTopTraders(db, { source: 'polymarket', sort: 'winRate' })
    expect(traders[0].id).toBe('0xcccc')
  })

  it('clamps the limit', async () => {
    expect(await loadTopTraders(db, { source: 'polymarket', limit: 1 })).toHaveLength(1)
    expect(await loadTopTraders(db, { source: 'polymarket', limit: 0 })).toHaveLength(1)
    expect(await loadTopTraders(db, { source: 'polymarket', limit: MAX_TRADERS * 10 })).toHaveLength(3)
  })
})

describe('loadTopTraders — zulu', () => {
  beforeEach(async () => {
    await db.insert(zuluTraders).values([
      { providerId: 11, name: 'Alpha', roiProfit: 12.5, winRate: 61, totalTrades: 40, zuluRank: 3, updatedAt: SYNCED },
      { providerId: 12, name: null, roiProfit: 30, winRate: 0.55, totalTrades: 900, zuluRank: 1 },
    ])
  })

  it('ranks by ROI profit and names unnamed traders by id', async () => {
    const traders = await loadTopTraders(db, { source: 'zulu' })
    expect(traders.map((t) => t.name)).toEqual(['Trader 12', 'Alpha'])
    expect(traders[0]).toMatchObject({
      source: 'zulu',
      id: '12',
      pnl: 30,
      volume: 900,
      profileUrl: 'https://www.zulutrade.com/trader/12',
    })
    expect(traders[0].winRate).toBeCloseTo(55)
  })

  it('sorts by trade count, win rate and Zulu rank', async () => {
    expect((await loadTopTraders(db, { source: 'zulu', sort: 'vol' }))[0].id).toBe('12')
    expect((await loadTopTraders(db, { source: 'zulu', sort: 'winRate' }))[0].id).toBe('11')
    expect((await loadTopTraders(db, { source: 'zulu', sort: 'rank' }))[0].id).toBe('12')
  })
})

describe('loadTopTraders — nvstly', () => {
  beforeEach(async () => {
    await db.insert(nvstlyLeaders).values([
      { id: 'n1', name: 'Steady', rank: 1, totalGain: 40, trades: 300, winRate: 70 },
      { id: 'n2', name: 'Moonshot', rank: 2, totalGain: 400, trades: 12, winRate: 0.3 },
    ])
  })

  it('ranks by total gain', async () => {
    const traders = await loadTopTraders(db, { source: 'nvstly' })
    expect(traders.map((t) => t.name)).toEqual(['Moonshot', 'Steady'])
    expect(traders[0]).toMatchObject({ pnl: 400, volume: 12, profileUrl: null })
    expect(traders[0].winRate).toBeCloseTo(30)
  })

  it('sorts by trades, win rate and rank', async () => {
    expect((await loadTopTraders(db, { source: 'nvstly', sort: 'vol' }))[0].id).toBe('n1')
    expect((await loadTopTraders(db, { source: 'nvstly', sort: 'winRate' }))[0].id).toBe('n1')
    expect((await loadTopTraders(db, { source: 'nvstly', sort: 'rank' }))[0].id).toBe('n1')
  })

  it('returns an empty list when nothing is synced', async () => {
    await db.delete(nvstlyLeaders)
    expect(await loadTopTraders(db, { source: 'nvstly' })).toEqual([])
  })
})

describe('countTradersBySource', () => {
  it('counts each table', async () => {
    await db.insert(polymarketLeaders).values([{ trader: 'a' }, { trader: 'b' }])
    await db.insert(nvstlyLeaders).values([{ id: 'n', name: 'N' }])
    expect(await countTradersBySource(db)).toEqual({ polymarket: 2, zulu: 0, nvstly: 1 })
  })
})
