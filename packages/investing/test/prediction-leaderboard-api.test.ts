/**
 * @fileoverview The data-api leaderboard takes upper-case enums and caps
 * limit at 50 and offset at 1000. The client used to send "all"/"Overall"
 * and limits of 100, so every leaderboard sync failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LEADERBOARD_MAX_OFFSET,
  LEADERBOARD_PAGE_LIMIT,
  buildLeaderboardUrl,
  fetchLeaderboard,
  fetchLeaderboardPages,
} from '../src/prediction/api/leaderboard'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

const params = (url: URL) => Object.fromEntries(url.searchParams.entries())

describe('buildLeaderboardUrl', () => {
  it('uses the API defaults in its own casing', () => {
    const url = buildLeaderboardUrl()
    expect(url.origin + url.pathname).toBe('https://data-api.polymarket.com/v1/leaderboard')
    expect(params(url)).toEqual({ timePeriod: 'ALL', orderBy: 'VOL', limit: '20', offset: '0', category: 'OVERALL' })
  })

  it.each([
    ['all', 'ALL'],
    ['1d', 'DAY'],
    ['7d', 'WEEK'],
    ['30d', 'MONTH'],
    ['WEEK', 'WEEK'],
    ['decade', 'ALL'],
  ])('maps timePeriod %s to %s', (input, expected) => {
    expect(buildLeaderboardUrl({ timePeriod: input }).searchParams.get('timePeriod')).toBe(expected)
  })

  it('upper-cases the category', () => {
    expect(buildLeaderboardUrl({ category: 'Politics' }).searchParams.get('category')).toBe('POLITICS')
    expect(buildLeaderboardUrl({ category: 'crypto' }).searchParams.get('category')).toBe('CRYPTO')
  })

  it('clamps limit and offset to what the API accepts', () => {
    const big = buildLeaderboardUrl({ limit: 500, offset: 50_000 })
    expect(big.searchParams.get('limit')).toBe(String(LEADERBOARD_PAGE_LIMIT))
    expect(big.searchParams.get('offset')).toBe(String(LEADERBOARD_MAX_OFFSET))

    const small = buildLeaderboardUrl({ limit: 0, offset: -10 })
    expect(small.searchParams.get('limit')).toBe('1')
    expect(small.searchParams.get('offset')).toBe('0')

    expect(buildLeaderboardUrl({ limit: Number.NaN }).searchParams.get('limit')).toBe('1')
  })

  it('only sends PNL or VOL as orderBy', () => {
    expect(buildLeaderboardUrl({ orderBy: 'PNL' }).searchParams.get('orderBy')).toBe('PNL')
    expect(buildLeaderboardUrl({ orderBy: 'junk' as 'VOL' }).searchParams.get('orderBy')).toBe('VOL')
  })
})

describe('fetchLeaderboard', () => {
  it('returns the rows', async () => {
    fetchMock.mockResolvedValue(json([{ rank: '1', proxyWallet: '0x1' }]))
    expect(await fetchLeaderboard({ limit: 5 })).toEqual([{ rank: '1', proxyWallet: '0x1' }])
    const [url, init] = fetchMock.mock.calls[0]
    expect((url as URL).searchParams.get('limit')).toBe('5')
    expect(init).toEqual({ headers: { accept: 'application/json' } })
  })

  it('throws with the status on an HTTP error', async () => {
    fetchMock.mockResolvedValue(json({ error: 'bad' }, 400))
    await expect(fetchLeaderboard()).rejects.toThrow('leaderboard fetch failed: 400')
  })

  it('treats a non-array body as no rows', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }))
    expect(await fetchLeaderboard()).toEqual([])
  })
})

describe('fetchLeaderboardPages', () => {
  const rows = (start: number, n: number) => Array.from({ length: n }, (_, i) => ({ rank: String(start + i) }))

  it('pages through 50-row pages until the limit is met', async () => {
    fetchMock
      .mockResolvedValueOnce(json(rows(1, 50)))
      .mockResolvedValueOnce(json(rows(51, 50)))
      .mockResolvedValueOnce(json(rows(101, 20)))
    const result = await fetchLeaderboardPages({ limit: 120, orderBy: 'PNL' })
    expect(result).toHaveLength(120)
    const sent = fetchMock.mock.calls.map(([url]) => [
      (url as URL).searchParams.get('offset'),
      (url as URL).searchParams.get('limit'),
      (url as URL).searchParams.get('orderBy'),
    ])
    expect(sent).toEqual([
      ['0', '50', 'PNL'],
      ['50', '50', 'PNL'],
      ['100', '20', 'PNL'],
    ])
  })

  it('stops at a short page', async () => {
    fetchMock.mockResolvedValueOnce(json(rows(1, 50))).mockResolvedValueOnce(json(rows(51, 7)))
    expect(await fetchLeaderboardPages({ limit: 200 })).toHaveLength(57)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops at an empty page', async () => {
    fetchMock.mockResolvedValueOnce(json([]))
    expect(await fetchLeaderboardPages({ limit: 100 })).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never requests past the offset cap', async () => {
    fetchMock.mockImplementation(async () => json(rows(1, 50)))
    const result = await fetchLeaderboardPages({ limit: 5000 })
    const offsets = fetchMock.mock.calls.map(([url]) => Number((url as URL).searchParams.get('offset')))
    expect(Math.max(...offsets)).toBeLessThanOrEqual(LEADERBOARD_MAX_OFFSET)
    expect(result.length).toBe(fetchMock.mock.calls.length * 50)
  })

  it('makes a single small request for a small limit', async () => {
    fetchMock.mockResolvedValueOnce(json(rows(1, 10)))
    expect(await fetchLeaderboardPages({ limit: 10 })).toHaveLength(10)
    expect((fetchMock.mock.calls[0][0] as URL).searchParams.get('limit')).toBe('10')
  })
})
