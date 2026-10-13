import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSession } from "@/lib/auth/session"
import { serverEnv } from "@/lib/env/runtime"
import { connectionFromToken, qwksearchOrigin, toSessionPayload } from "@/lib/qwksearch/connect"
import { loadConnection, saveConnection } from "@/lib/qwksearch/store"

const noStore = { "Cache-Control": "no-store" }

/** Asks QwkSearch who `apiKey` belongs to: the profile, or "invalid" / null (unreachable). */
async function describeKey(apiKey: string): Promise<unknown | "invalid" | null> {
  const res = await fetch(new URL("/api/connect/me", qwksearchOrigin(serverEnv("QWKSEARCH_ORIGIN"))), {
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
  })
  if (res.status === 401) return "invalid"
  return res.ok ? res.json() : null
}

/**
 * GET — the signed-in user's linked QwkSearch account, in the shape
 * research-agent-ui's connect auth client reads: `{ connected, user, apiKey,
 * plan, upgradeUrl }`. The key is the user's own and goes only to them; the
 * embed needs it to call qwksearch.com as that account.
 *
 * `?refresh=1` re-reads the profile and plan from QwkSearch first — the
 * settings dialog asks for it when the user comes back from upgrading. A key
 * QwkSearch no longer accepts (regenerated there) unlinks the account.
 */
export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ connected: false }, { headers: noStore })

  let connection = await loadConnection(db, session.user.id)
  if (connection && request.nextUrl.searchParams.get("refresh") === "1") {
    try {
      const profile = await describeKey(connection.apiKey)
      if (profile === "invalid") {
        connection = null
        await saveConnection(db, session.user.id, null)
      } else if (profile) {
        const refreshed = connectionFromToken(profile, connection)
        if (refreshed) {
          connection = refreshed
          await saveConnection(db, session.user.id, refreshed)
        }
      }
    } catch (error) {
      // QwkSearch unreachable: keep serving what we have.
      console.warn("[qwksearch] plan refresh failed:", error)
    }
  }

  return NextResponse.json(toSessionPayload(connection), { headers: noStore })
}

/**
 * POST `{ apiKey }` — links a QwkSearch account by its API key (from
 * qwksearch.com → Settings → Account) instead of the consent screen. The key
 * is checked with QwkSearch before it is stored.
 */
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore })

  const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : ""
  if (!apiKey || apiKey.length > 512) {
    return NextResponse.json({ error: "Enter a QwkSearch API key." }, { status: 400, headers: noStore })
  }

  let profile: unknown
  try {
    profile = await describeKey(apiKey)
  } catch (error) {
    console.error("[qwksearch] key check failed:", error)
    profile = null
  }
  if (profile === "invalid") {
    return NextResponse.json({ error: "QwkSearch did not accept that API key." }, { status: 400, headers: noStore })
  }
  const connection = profile ? connectionFromToken({ ...(profile as object), api_key: apiKey }) : null
  if (!connection) {
    return NextResponse.json({ error: "Could not reach QwkSearch. Try again." }, { status: 502, headers: noStore })
  }

  await saveConnection(db, session.user.id, connection)
  return NextResponse.json(toSessionPayload(connection), { headers: noStore })
}
