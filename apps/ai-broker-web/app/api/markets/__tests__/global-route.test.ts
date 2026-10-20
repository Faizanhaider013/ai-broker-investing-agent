/**
 * @fileoverview GET /api/markets/global asks Dukascopy only for instruments
 * it knows; an unknown one throws inside the client on every request.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { Instrument } from 'dukascopy-node'

const getRealTimeData = vi.hoisted(() => vi.fn(async () => ({ success: false })))

vi.mock('@/packages/investing/src/live-data/dukascopy-client', () => ({
  getRealTimeData,
  getHistoricalData: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}))

import { GET } from '../global/route'

describe('GET /api/markets/global', () => {
  it('requests only instruments dukascopy-node supports', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await GET(new NextRequest('http://localhost/api/markets/global'))
    const asked = getRealTimeData.mock.calls.map(([config]) => (config as { instrument: string }).instrument)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.filter((s) => !(s in Instrument))).toEqual([])
  })
})
