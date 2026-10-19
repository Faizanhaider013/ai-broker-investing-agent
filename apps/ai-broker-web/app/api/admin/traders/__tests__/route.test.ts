/**
 * @fileoverview Route tests for the admin top-traders endpoints and the
 * per-source sync dispatcher behind them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const loadTopTraders = vi.hoisted(() => vi.fn())
const countTradersBySource = vi.hoisted(() => vi.fn())
const syncLeaderboard = vi.hoisted(() => vi.fn())
const syncZuluTraders = vi.hoisted(() => vi.fn())
const syncCopyTradingLeadersOrders = vi.hoisted(() => vi.fn())

vi.mock('@/lib/admin/db', () => ({ getAdminDB: vi.fn(() => 'db') }))
vi.mock('@/lib/auth/admin', () => ({ assertAdmin: vi.fn() }))
vi.mock('@/lib/admin/traders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/traders')>()),
  loadTopTraders,
  countTradersBySource,
}))
vi.mock('@/packages/investing/src/prediction', () => ({ syncLeaderboard }))
vi.mock('@/packages/investing/src/leaders/zulu', () => ({ syncZuluTraders }))
vi.mock('@/packages/investing/src/leaders/nvsty-leaders', () => ({ syncCopyTradingLeadersOrders }))

import { assertAdmin } from '@/lib/auth/admin'
import { jsonRequest } from '../../../__tests__/helpers/fake-db'
import { GET } from '../route'
import { POST as SYNC } from '../sync/route'
import { MAX_POLYMARKET_SYNC, syncTraderSource } from '@/lib/admin/trader-sync'

const mockAssertAdmin = assertAdmin as unknown as ReturnType<typeof vi.fn>
const COUNTS = { polymarket: 3, zulu: 0, nvstly: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockAssertAdmin.mockResolvedValue(null)
  loadTopTraders.mockResolvedValue([{ id: 'x', rank: 1 }])
  countTradersBySource.mockResolvedValue(COUNTS)
  syncLeaderboard.mockResolvedValue({ leaders: 120 })
  syncZuluTraders.mockResolvedValue({ traders: 75 })
  syncCopyTradingLeadersOrders.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
})

describe('GET /api/admin/traders', () => {
  const get = (qs = '') => GET(jsonRequest(`http://localhost/api/admin/traders${qs}`, 'GET'))

  it('defaults to Polymarket by PnL, top 50', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(loadTopTraders).toHaveBeenCalledWith('db', { source: 'polymarket', sort: 'pnl', limit: 50 })
    expect(await res.json()).toEqual({ source: 'polymarket', traders: [{ id: 'x', rank: 1 }], counts: COUNTS })
  })

  it('passes the source, sort and limit through', async () => {
    await get('?source=zulu&sort=winRate&limit=10')
    expect(loadTopTraders).toHaveBeenCalledWith('db', { source: 'zulu', sort: 'winRate', limit: 10 })
  })

  it('falls back to PnL for an unknown sort', async () => {
    await get('?source=nvstly&sort=bogus&limit=x')
    expect(loadTopTraders).toHaveBeenCalledWith('db', { source: 'nvstly', sort: 'pnl', limit: 50 })
  })

  it('400s on an unknown source', async () => {
    const res = await get('?source=robinhood')
    expect(res.status).toBe(400)
    expect(loadTopTraders).not.toHaveBeenCalled()
  })

  it('returns the guard response for a non-admin', async () => {
    mockAssertAdmin.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    expect((await get()).status).toBe(403)
    expect(loadTopTraders).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/traders/sync', () => {
  const sync = (body: unknown) => SYNC(jsonRequest('http://localhost/api/admin/traders/sync', 'POST', body))

  it('syncs the Polymarket leaderboard by PnL over all time', async () => {
    const res = await sync({ source: 'polymarket', limit: 200 })
    expect(res.status).toBe(200)
    expect(syncLeaderboard).toHaveBeenCalledWith({ limit: 200, orderBy: 'PNL', timePeriod: 'all' })
    expect(await res.json()).toEqual({ success: true, source: 'polymarket', synced: 120 })
  })

  it('syncs by volume when asked', async () => {
    await sync({ source: 'polymarket', orderBy: 'VOL' })
    expect(syncLeaderboard).toHaveBeenCalledWith({ limit: 100, orderBy: 'VOL', timePeriod: 'all' })
  })

  it('syncs ZuluTrade', async () => {
    const body = await (await sync({ source: 'zulu', limit: 200 })).json()
    expect(syncZuluTraders).toHaveBeenCalledWith({ limit: 200 })
    expect(body).toEqual({ success: true, source: 'zulu', synced: 75 })
  })

  it('syncs NVSTLY and counts the leaders it saved', async () => {
    const body = await (await sync({ source: 'nvstly' })).json()
    expect(body).toEqual({ success: true, source: 'nvstly', synced: 2 })
  })

  it('400s without a known source', async () => {
    expect((await sync({})).status).toBe(400)
    expect((await sync({ source: 'etoro' })).status).toBe(400)
    expect(syncLeaderboard).not.toHaveBeenCalled()
  })

  it('reports an upstream failure as a 502', async () => {
    syncZuluTraders.mockRejectedValue(new Error('Zulu fetch failed: 403'))
    const res = await sync({ source: 'zulu' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, source: 'zulu', error: 'Zulu fetch failed: 403' })
  })

  it('returns the guard response for a non-admin', async () => {
    mockAssertAdmin.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await sync({ source: 'zulu' })).status).toBe(401)
    expect(syncZuluTraders).not.toHaveBeenCalled()
  })
})

describe('syncTraderSource', () => {
  it('clamps the Polymarket limit', async () => {
    await syncTraderSource('polymarket', { limit: 1_000_000 })
    expect(syncLeaderboard).toHaveBeenLastCalledWith(expect.objectContaining({ limit: MAX_POLYMARKET_SYNC }))
    await syncTraderSource('polymarket', { limit: -3 })
    expect(syncLeaderboard).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 1 }))
  })

  it('counts zero NVSTLY leaders when the sync returns nothing usable', async () => {
    syncCopyTradingLeadersOrders.mockResolvedValue(undefined)
    expect(await syncTraderSource('nvstly')).toEqual({ source: 'nvstly', synced: 0 })
  })
})
