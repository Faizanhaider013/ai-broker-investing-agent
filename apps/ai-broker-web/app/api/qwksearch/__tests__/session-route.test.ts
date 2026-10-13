/**
 * @fileoverview GET /api/qwksearch/session reports "not connected" rather
 * than a 500 when the connection lookup fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const loadConnection = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({ db: 'db' }))
vi.mock('@/lib/auth/session', () => ({ getSession: vi.fn(async () => ({ user: { id: 'u1' } })) }))
vi.mock('@/lib/env/runtime', () => ({ serverEnv: vi.fn() }))
vi.mock('@/lib/qwksearch/store', () => ({ loadConnection, saveConnection: vi.fn() }))

import { GET } from '../session/route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GET /api/qwksearch/session', () => {
  it('reports not connected when there is no linked account', async () => {
    loadConnection.mockResolvedValue(null)
    const res = await GET(new NextRequest('http://localhost/api/qwksearch/session'))
    expect(res.status).toBe(200)
    expect((await res.json()).connected).toBe(false)
  })

  it('reports not connected, not a 500, when qwksearch_connections is missing', async () => {
    loadConnection.mockRejectedValue(new Error('D1_ERROR: no such table: qwksearch_connections'))
    const res = await GET(new NextRequest('http://localhost/api/qwksearch/session'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ connected: false })
  })
})
