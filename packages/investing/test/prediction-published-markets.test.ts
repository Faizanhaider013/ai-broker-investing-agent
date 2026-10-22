/**
 * @fileoverview The SQL condition the public market queries use to leave out
 * markets an admin unpublished. (It is executed against real SQLite in the
 * web app's lib/admin/__tests__/public-markets.test.ts.)
 */
import { describe, it, expect, vi } from 'vitest'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'

vi.mock('../src/db', () => ({ db: {} }))

import { PM_MARKET_LISTING_KIND, publishedMarketCondition } from '../src/prediction/db/markets'

describe('publishedMarketCondition', () => {
  const query = new SQLiteSyncDialect().sqlToQuery(publishedMarketCondition())

  it('is a NOT EXISTS over unpublished pm-market rows', () => {
    expect(query.sql).toMatch(/^not exists \(select 1 from "listing_controls" where /)
    expect(query.sql).toContain('"listing_controls"."published" = 0')
    expect(query.params).toEqual([PM_MARKET_LISTING_KIND])
  })

  it('correlates on the outer market id', () => {
    expect(query.sql).toContain('"listing_controls"."item_id" = "polymarket_markets"."id"')
  })

  it('uses the kind the admin module writes', () => {
    expect(PM_MARKET_LISTING_KIND).toBe('pm-market')
  })
})
