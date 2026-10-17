import { NextRequest, NextResponse } from 'next/server'
import { syncMarketsIncremental, syncLeadersAndCategories } from '@/packages/investing/src/prediction'
import { auth } from '@/lib/auth'
import { isCronRequest } from '@/lib/auth/cron'
import { headers } from 'next/headers'

/**
 * Cron job to sync Polymarket data every 5 minutes
 * Performs a lightweight market sync (no price history or holders)
 * and syncs leaders and categories
 */
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
    console.log('Starting cron job: Syncing Polymarket markets (lightweight)...')
    const startTime = Date.now()

    // Lightweight sync: markets only (no price history or holders)
    const marketsResult = await syncMarketsIncremental(1000, false, false)

    // Also sync leaders and categories
    const leadersResult = await syncLeadersAndCategories()

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    const message = `Synced ${marketsResult.markets} markets and leaders/categories in ${duration}s`

    console.log(`Cron job completed: ${message}`)

    return NextResponse.json({
      success: true,
      markets: marketsResult.markets,
      leaders: leadersResult,
      duration: `${duration}s`,
      message,
      cronJob: true,
      timestamp: new Date().toISOString()
    })
  } catch (error: any) {
    console.error('Polymarket sync error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Sync failed',
        cronJob: true,
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    )
  }
}
