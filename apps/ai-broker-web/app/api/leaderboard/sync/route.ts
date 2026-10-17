import { NextResponse } from 'next/server'
import { syncZuluTraders } from '@/packages/investing/src/leaders/zulu'
import { syncLeadersAndCategories } from '@/packages/investing/src/prediction'

export async function POST() {
  try {
    // Each source syncs independently: one upstream being down (ZuluTrade
    // and polymarketanalytics.com both rate-limit) must not throw away the
    // other's fresh leaders or fail the whole request.
    const [zulu, polymarket] = await Promise.allSettled([
      syncZuluTraders(),
      syncLeadersAndCategories()
    ])
    const outcome = (r: PromiseSettledResult<unknown>) =>
      r.status === 'fulfilled'
        ? r.value
        : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }
    const failed = [zulu, polymarket].filter((r) => r.status === 'rejected').length

    return NextResponse.json(
      {
        success: failed < 2,
        message: failed === 0 ? 'Sync completed successfully' : `Sync completed with ${failed} failed source(s)`,
        results: {
          zulu: outcome(zulu),
          polymarket: outcome(polymarket)
        }
      },
      { status: failed === 2 ? 502 : 200 }
    )
  } catch (error: any) {
    console.error('Leaderboard sync failed:', error)
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    )
  }
}
