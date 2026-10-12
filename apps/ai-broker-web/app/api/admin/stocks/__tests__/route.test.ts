/**
 * @fileoverview Route tests for the admin stock publishing endpoints and the
 * public featured-stocks list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const listings = vi.hoisted(() => ({
  listStockControls: vi.fn(),
  upsertStockControl: vi.fn(),
  deleteStockControl: vi.fn(),
  getFeaturedStocks: vi.fn(),
}))

vi.mock('@/lib/admin/db', () => ({ getAdminDB: vi.fn(() => 'db') }))
vi.mock('@/lib/auth/admin', () => ({ assertAdmin: vi.fn(), getAdminAccess: vi.fn() }))
vi.mock('@/lib/admin/listings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/listings')>()),
  ...listings,
}))

import { assertAdmin, getAdminAccess } from '@/lib/auth/admin'
import { jsonRequest } from '../../../__tests__/helpers/fake-db'
import { DELETE, GET, POST } from '../route'
import { GET as FEATURED } from '../../../stocks/featured/route'

const mockAssertAdmin = assertAdmin as unknown as ReturnType<typeof vi.fn>
const mockAccess = getAdminAccess as unknown as ReturnType<typeof vi.fn>
const URL_BASE = 'http://localhost/api/admin/stocks'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mockAssertAdmin.mockResolvedValue(null)
  mockAccess.mockResolvedValue({ isAdmin: true, email: 'admin@example.com' })
  listings.upsertStockControl.mockImplementation(async (_db, input) => ({ ...input, label: input.label ?? null }))
})

describe('admin guard', () => {
  it.each([
    ['GET', () => GET()],
    ['POST', () => POST(jsonRequest(URL_BASE, 'POST', { symbol: 'AAPL', published: true }))],
    ['DELETE', () => DELETE(jsonRequest(`${URL_BASE}?symbol=AAPL`, 'DELETE'))],
  ])('%s is refused for a signed-out caller', async (_name, call) => {
    mockAssertAdmin.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await call()).status).toBe(401)
    expect(listings.listStockControls).not.toHaveBeenCalled()
    expect(listings.upsertStockControl).not.toHaveBeenCalled()
    expect(listings.deleteStockControl).not.toHaveBeenCalled()
  })
})

describe('GET /api/admin/stocks', () => {
  it('returns the decisions with featured and hidden counts', async () => {
    listings.listStockControls.mockResolvedValue([
      { symbol: 'AAPL', published: true },
      { symbol: 'MSFT', published: true },
      { symbol: 'GME', published: false },
    ])
    const body = await (await GET()).json()
    expect(body.counts).toEqual({ featured: 2, hidden: 1 })
    expect(body.stocks).toHaveLength(3)
  })
})

describe('POST /api/admin/stocks', () => {
  const post = (body: unknown) => POST(jsonRequest(URL_BASE, 'POST', body))

  it('features one stock with a trimmed label and note', async () => {
    const res = await post({ symbol: 'aapl', published: true, label: '  Apple  ', note: ' core ' })
    expect(res.status).toBe(200)
    expect(listings.upsertStockControl).toHaveBeenCalledWith(
      'db',
      { symbol: 'AAPL', published: true, label: 'Apple', note: 'core' },
      'admin@example.com',
    )
  })

  it('turns a blank label into null so it can be cleared', async () => {
    await post({ symbol: 'AAPL', published: true, label: '   ' })
    expect(listings.upsertStockControl.mock.calls[0][1]).toMatchObject({ label: null })
  })

  it('leaves the label untouched when it is not sent', async () => {
    await post({ symbol: 'AAPL', published: false })
    expect(listings.upsertStockControl.mock.calls[0][1]).toEqual({
      symbol: 'AAPL',
      published: false,
      label: undefined,
      note: undefined,
    })
  })

  it('applies one decision to several symbols, de-duplicated, without labels', async () => {
    const res = await post({ symbols: ['tsla', 'GME', 'TSLA'], published: false, label: 'ignored' })
    expect(res.status).toBe(200)
    expect(listings.upsertStockControl).toHaveBeenCalledTimes(2)
    expect(listings.upsertStockControl.mock.calls.map((c) => c[1])).toEqual([
      { symbol: 'TSLA', published: false },
      { symbol: 'GME', published: false },
    ])
    expect((await res.json()).stocks).toHaveLength(2)
  })

  it.each([
    [{ symbol: 'AAPL' }, '`published` must be a boolean'],
    [{ symbol: 'AAPL', published: 1 }, '`published` must be a boolean'],
    [{ symbols: [], published: true }, 'Send between 1 and 50 symbols'],
    [{ symbol: 'not a ticker', published: true }, 'Invalid symbol: not a ticker'],
    [{ published: true }, 'Invalid symbol: undefined'],
    [{ symbols: ['AAPL', '$$$'], published: true }, 'Invalid symbol: $$$'],
  ])('rejects %j', async (body, error) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(error)
    expect(listings.upsertStockControl).not.toHaveBeenCalled()
  })

  it('caps the batch size', async () => {
    const symbols = Array.from({ length: 51 }, (_, i) => `S${i}`)
    expect((await post({ symbols, published: true })).status).toBe(400)
  })

  it('caps label and note length', async () => {
    await post({ symbol: 'AAPL', published: true, label: 'x'.repeat(500), note: 'y'.repeat(900) })
    const input = listings.upsertStockControl.mock.calls[0][1]
    expect(input.label).toHaveLength(120)
    expect(input.note).toHaveLength(500)
  })
})

describe('DELETE /api/admin/stocks', () => {
  it('clears a decision', async () => {
    listings.deleteStockControl.mockResolvedValue(true)
    const res = await DELETE(jsonRequest(`${URL_BASE}?symbol=aapl`, 'DELETE'))
    expect(res.status).toBe(200)
    expect(listings.deleteStockControl).toHaveBeenCalledWith('db', 'AAPL')
    expect(await res.json()).toEqual({ deleted: 'AAPL' })
  })

  it('404s when there was nothing to clear', async () => {
    listings.deleteStockControl.mockResolvedValue(false)
    const res = await DELETE(jsonRequest(`${URL_BASE}?symbol=AAPL`, 'DELETE'))
    expect(res.status).toBe(404)
  })

  it('400s without a valid symbol', async () => {
    expect((await DELETE(jsonRequest(URL_BASE, 'DELETE'))).status).toBe(400)
    expect((await DELETE(jsonRequest(`${URL_BASE}?symbol=%20`, 'DELETE'))).status).toBe(400)
  })
})

describe('GET /api/stocks/featured (public)', () => {
  it('serves the featured list without an admin check', async () => {
    listings.getFeaturedStocks.mockResolvedValue([{ symbol: 'AAPL', label: 'Apple' }])
    const res = await FEATURED()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, count: 1, data: [{ symbol: 'AAPL', label: 'Apple' }] })
    expect(mockAssertAdmin).not.toHaveBeenCalled()
  })

  it('returns an empty list with a 500 when the lookup fails', async () => {
    listings.getFeaturedStocks.mockRejectedValue(new Error('D1 down'))
    const res = await FEATURED()
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false, data: [] })
  })
})
