/**
 * @fileoverview Route tests for the admin prediction-market endpoints: the
 * listing, bulk publish/unpublish validation, and the Polymarket refill.
 * The query logic itself is covered against real SQL in lib/admin/__tests__.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const listings = vi.hoisted(() => ({
  listMarketsForAdmin: vi.fn(),
  listMarketCategories: vi.fn(),
  setMarketsPublished: vi.fn(),
  setAllMarketsPublished: vi.fn(),
}))
const refillMarkets = vi.hoisted(() => vi.fn())

vi.mock('@/lib/admin/db', () => ({ getAdminDB: vi.fn(() => 'db') }))
vi.mock('@/lib/auth/admin', () => ({ assertAdmin: vi.fn(), getAdminAccess: vi.fn() }))
vi.mock('@/lib/admin/listings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/listings')>()),
  ...listings,
}))
vi.mock('@/packages/investing/src/prediction', async () => {
  const { clampRefillSize } = await import('@/packages/investing/src/prediction/sync/refill-limits')
  return { refillMarkets, clampRefillSize }
})

import { assertAdmin, getAdminAccess } from '@/lib/auth/admin'
import { jsonRequest } from '../../../__tests__/helpers/fake-db'
import { GET, PATCH } from '../route'
import { POST as REFILL } from '../refill/route'

const mockAssertAdmin = assertAdmin as unknown as ReturnType<typeof vi.fn>
const mockAccess = getAdminAccess as unknown as ReturnType<typeof vi.fn>

const emptyPage = {
  markets: [],
  page: 1,
  limit: 25,
  matched: 0,
  pageCount: 1,
  counts: { total: 0, published: 0, unpublished: 0 },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockAssertAdmin.mockResolvedValue(null)
  mockAccess.mockResolvedValue({ isAdmin: true, email: 'admin@example.com' })
  listings.listMarketsForAdmin.mockResolvedValue(emptyPage)
  listings.listMarketCategories.mockResolvedValue(['Politics', 'Sports'])
  listings.setMarketsPublished.mockResolvedValue({ updated: ['m1'], missing: [] })
  listings.setAllMarketsPublished.mockResolvedValue(7)
})

describe('admin guard', () => {
  it.each([
    ['GET', () => GET(jsonRequest('http://localhost/api/admin/markets', 'GET'))],
    ['PATCH', () => PATCH(jsonRequest('http://localhost/api/admin/markets', 'PATCH', { ids: ['m1'], published: true }))],
    ['refill', () => REFILL(jsonRequest('http://localhost/api/admin/markets/refill', 'POST', {}))],
  ])('%s returns the guard response for a non-admin', async (_name, call) => {
    mockAssertAdmin.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
    const res = await call()
    expect(res.status).toBe(403)
    expect(listings.listMarketsForAdmin).not.toHaveBeenCalled()
    expect(listings.setMarketsPublished).not.toHaveBeenCalled()
    expect(refillMarkets).not.toHaveBeenCalled()
  })
})

describe('GET /api/admin/markets', () => {
  it('passes the filters through and adds the categories', async () => {
    const res = await GET(
      jsonRequest(
        'http://localhost/api/admin/markets?q=trump&category=Politics&status=unpublished&sort=volumeTotal&active=true&page=3&limit=10',
        'GET',
      ),
    )
    expect(res.status).toBe(200)
    expect(listings.listMarketsForAdmin).toHaveBeenCalledWith('db', {
      q: 'trump',
      category: 'Politics',
      status: 'unpublished',
      sort: 'volumeTotal',
      activeOnly: true,
      page: 3,
      limit: 10,
    })
    expect((await res.json()).categories).toEqual(['Politics', 'Sports'])
  })

  it('falls back to safe defaults for unknown values', async () => {
    await GET(jsonRequest('http://localhost/api/admin/markets?status=deleted&sort=drop&page=-2&limit=abc', 'GET'))
    expect(listings.listMarketsForAdmin).toHaveBeenCalledWith('db', expect.objectContaining({
      status: 'all',
      sort: 'volume24hr',
      activeOnly: false,
      page: 1,
      limit: 25,
    }))
  })
})

describe('PATCH /api/admin/markets', () => {
  const patch = (body: unknown) => PATCH(jsonRequest('http://localhost/api/admin/markets', 'PATCH', body))

  it('publishes the given ids as the signed-in admin', async () => {
    const res = await patch({ ids: ['m1', 'ghost'], published: false })
    expect(res.status).toBe(200)
    expect(listings.setMarketsPublished).toHaveBeenCalledWith('db', ['m1', 'ghost'], false, 'admin@example.com')
    expect(await res.json()).toEqual({ updated: 1, missing: [], published: false })
  })

  it('publishes everything in a category', async () => {
    const res = await patch({ all: true, published: true, category: 'Sports' })
    expect(listings.setAllMarketsPublished).toHaveBeenCalledWith('db', true, 'admin@example.com', { category: 'Sports' })
    expect(await res.json()).toEqual({ updated: 7, published: true })
  })

  it.each([
    [{ ids: ['m1'] }, '`published` must be a boolean'],
    [{ ids: ['m1'], published: 'yes' }, '`published` must be a boolean'],
    [{ published: true }, '`ids` must be a non-empty array of market ids'],
    [{ ids: [], published: true }, '`ids` must be a non-empty array of market ids'],
    [{ ids: [1, 2], published: true }, '`ids` must be a non-empty array of market ids'],
    [{ ids: 'm1', published: true }, '`ids` must be a non-empty array of market ids'],
  ])('rejects %j', async (body, error) => {
    const res = await patch(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(error)
    expect(listings.setMarketsPublished).not.toHaveBeenCalled()
  })

  it('rejects a malformed JSON body', async () => {
    const req = new Request('http://localhost/api/admin/markets', { method: 'PATCH', body: '{nope' }) as any
    expect((await PATCH(req)).status).toBe(400)
  })

  it('caps how many ids one request may touch', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `m${i}`)
    const res = await patch({ ids, published: true })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/At most 50/)
  })
})

describe('POST /api/admin/markets/refill', () => {
  const refill = (body?: unknown) =>
    REFILL(jsonRequest('http://localhost/api/admin/markets/refill', 'POST', body))

  it('refills with the defaults', async () => {
    refillMarkets.mockResolvedValue({ markets: 500, pricePoints: 0, holders: 0, deactivated: 12 })
    const res = await refill({})
    expect(res.status).toBe(200)
    expect(refillMarkets).toHaveBeenCalledWith({
      maxMarkets: 500,
      priceHistory: false,
      holders: false,
      deactivateExpired: true,
    })
    const body = await res.json()
    expect(body).toMatchObject({ success: true, markets: 500, deactivated: 12, requested: 500 })
    expect(body.message).toMatch(/^Refilled 500 markets and retired 12 ended ones in/)
  })

  it('honours the options and clamps the size', async () => {
    refillMarkets.mockResolvedValue({ markets: 5000, pricePoints: 1, holders: 2, deactivated: 0 })
    await refill({ maxMarkets: 99999, priceHistory: true, holders: true, deactivateExpired: false })
    expect(refillMarkets).toHaveBeenCalledWith({
      maxMarkets: 5000,
      priceHistory: true,
      holders: true,
      deactivateExpired: false,
    })
  })

  it('treats a missing body as the defaults', async () => {
    refillMarkets.mockResolvedValue({ markets: 1, pricePoints: 0, holders: 0, deactivated: 0 })
    const req = new Request('http://localhost/api/admin/markets/refill', { method: 'POST' }) as any
    expect((await REFILL(req)).status).toBe(200)
    expect(refillMarkets).toHaveBeenCalledWith(expect.objectContaining({ maxMarkets: 500 }))
  })

  it('reports an upstream failure as a 502', async () => {
    refillMarkets.mockRejectedValue(new Error('Polymarket API returned 429'))
    const res = await refill({})
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'Polymarket API returned 429' })
  })
})
