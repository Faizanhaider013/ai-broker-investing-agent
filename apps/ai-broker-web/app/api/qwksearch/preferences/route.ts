import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSession } from "@/lib/auth/session"
import { sanitizePreferences } from "@/lib/qwksearch/preferences"
import { loadPreferences, savePreferences } from "@/lib/qwksearch/store"

const noStore = { "Cache-Control": "no-store" }

/** GET — the signed-in user's saved research-agent preferences (`{}` when none). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore })
  return NextResponse.json({ preferences: await loadPreferences(db, session.user.id) }, { headers: noStore })
}

/** PUT `{ preferences }` — replaces them; malformed entries are dropped (lib/qwksearch/preferences.ts). */
export async function PUT(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore })
  const body = (await request.json().catch(() => null)) as { preferences?: unknown } | null
  const preferences = sanitizePreferences(body?.preferences)
  await savePreferences(db, session.user.id, preferences)
  return NextResponse.json({ preferences }, { headers: noStore })
}
