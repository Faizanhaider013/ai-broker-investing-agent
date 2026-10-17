import { NextRequest, NextResponse } from 'next/server'
import { syncZuluTraders, syncZuluTraderDetails, getZuluTopByRank } from '@/packages/investing/src/leaders/zulu'
import { assertAdmin } from '@/lib/auth/admin'
import { isCronRequest } from '@/lib/auth/cron'

export async function GET(request: NextRequest) {
  // Allow access if a valid CRON_SECRET bearer token is provided (scheduled runs)
  const isCronJob = isCronRequest(request.headers.get('authorization'))

  // Otherwise only an admin may trigger it: it writes to D1 and calls ZuluTrade ~20 times.
  if (!isCronJob) {
    const guard = await assertAdmin()
    if (guard) return guard
  }

  try {
    const listResult = await syncZuluTraders()

    const topTraders = await getZuluTopByRank(20)
    const topIds = topTraders.map(t => t.providerId)

    const detailsResult = await syncZuluTraderDetails(topIds)

    return NextResponse.json({
      success: true,
      traders: listResult.traders,
      details: detailsResult.details,
    })
  } catch (error: any) {
    console.error('Zulu sync error:', error)
    return NextResponse.json(
      { error: error.message || 'Sync failed' },
      { status: 500 }
    )
  }
}
