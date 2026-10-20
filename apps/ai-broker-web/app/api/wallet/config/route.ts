import { NextResponse } from "next/server"
import { serverEnv } from "@/lib/env/runtime"

/**
 * GET /api/wallet/config
 * Public client settings for the in-app (Privy) wallet. Read at request time
 * so setting PRIVY_APP_ID as a Worker variable needs no rebuild. The Privy
 * App ID and Client ID are public identifiers, not secrets.
 */
export async function GET() {
  return NextResponse.json({
    privyAppId: serverEnv("PRIVY_APP_ID") ?? serverEnv("NEXT_PUBLIC_PRIVY_APP_ID") ?? null,
    privyClientId: serverEnv("PRIVY_CLIENT_ID") ?? serverEnv("NEXT_PUBLIC_PRIVY_CLIENT_ID") ?? null,
  })
}
