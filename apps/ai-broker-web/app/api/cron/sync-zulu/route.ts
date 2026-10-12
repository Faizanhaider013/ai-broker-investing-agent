import { NextRequest, NextResponse } from 'next/server'
import { syncZuluTraders, syncZuluTraderDetails, getZuluTopByRank } from '@/packages/investing/src/leaders/zulu'
import { auth } from '@/lib/auth'
import { isCronRequest } from '@/lib/auth/cron'
import { headers } from 'next/headers'

export async function GET(request: NextRequest) {
  // Allow access if a valid CRON_SECRET bearer token is provided (scheduled runs)
  const isCronJob = isCronRequest(request.headers.get('authorization'))

  // Otherwise, require user authentication
  if (!isCronJob) {
    const session = await auth.api.getSession({
      headers: await headers()
    })

    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
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
