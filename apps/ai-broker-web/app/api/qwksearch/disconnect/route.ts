import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSession } from "@/lib/auth/session"
import { saveConnection } from "@/lib/qwksearch/store"

/**
 * POST — unlinks the user's QwkSearch account: forgets the stored key, so the
 * research agent goes back to running as a guest. (The key itself stays valid
 * on QwkSearch until the user regenerates it there.) Preferences are kept.
 */
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await saveConnection(db, session.user.id, null)
  return NextResponse.json({ connected: false })
}
