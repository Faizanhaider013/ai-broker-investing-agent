/**
 * @fileoverview /api/wallet/config hands the browser the Privy App ID, read
 * from the environment at request time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/env/runtime', () => ({ serverEnv: vi.fn() }))

import { serverEnv } from '@/lib/env/runtime'
import { GET } from '../config/route'

const mockServerEnv = serverEnv as unknown as ReturnType<typeof vi.fn>

function setEnv(values: Record<string, string>) {
  mockServerEnv.mockImplementation((name: string) => values[name])
}

beforeEach(() => vi.clearAllMocks())

describe('GET /api/wallet/config', () => {
  it('returns nulls when Privy is not configured', async () => {
    setEnv({})
    await expect((await GET()).json()).resolves.toEqual({ privyAppId: null, privyClientId: null })
  })

  it('falls back to NEXT_PUBLIC_PRIVY_APP_ID', async () => {
    setEnv({ NEXT_PUBLIC_PRIVY_APP_ID: 'public-id' })
    expect((await (await GET()).json()).privyAppId).toBe('public-id')
  })

  it('prefers PRIVY_APP_ID and returns the client id', async () => {
    setEnv({ PRIVY_APP_ID: 'app-id', NEXT_PUBLIC_PRIVY_APP_ID: 'public-id', PRIVY_CLIENT_ID: 'client-id' })
    await expect((await GET()).json()).resolves.toEqual({ privyAppId: 'app-id', privyClientId: 'client-id' })
  })
})
