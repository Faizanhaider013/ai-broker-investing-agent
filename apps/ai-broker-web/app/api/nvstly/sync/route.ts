import { NextRequest, NextResponse } from 'next/server'
import { syncCopyTradingLeadersOrders } from '@/packages/investing/src/leaders/nvsty-leaders'
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
    await syncCopyTradingLeadersOrders()
    return NextResponse.json({
      success: true,
      message: 'NVSTLY leaders and orders synced successfully'
    })
  } catch (error: any) {
    console.error('NVSTLY sync error:', error)
    return NextResponse.json(
      { error: error.message || 'Sync failed' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
