import { NextRequest, NextResponse } from 'next/server'
import { syncZuluTraders } from '@/packages/investing/src/leaders/zulu'
import { assertAdmin } from '@/lib/auth/admin'
import { isCronRequest } from '@/lib/auth/cron'

/** Pulls ZuluTrade's top traders into D1. Admins or the cron secret only: it writes. */
export async function POST(request: NextRequest) {
  if (!isCronRequest(request.headers.get('authorization'))) {
    const guard = await assertAdmin()
    if (guard) return guard
  }

  try {
    const result = await syncZuluTraders()
    
    return NextResponse.json({
      success: true,
      data: result,
      message: `Successfully synced ${result.traders} traders`
    })
  } catch (error: any) {
    console.error('Error syncing Zulu traders:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: error.message || 'Failed to sync traders' 
      },
      { status: 502 }
    )
  }
}
