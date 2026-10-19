import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSession } from "@/lib/auth/session"
import { DocumentInputError, listDocuments, saveDocument } from "@/lib/qwksearch/documents"

const noStore = { "Cache-Control": "no-store" }

/**
 * The Research Agent's docs storage (lib/qwksearch/documents.ts). GET lists
 * the signed-in user's documents and folders; POST creates one with a new id
 * (PUT `/:id` creates one under the editor's own id). Signed-out
 * visitors get 401, and the editor keeps their documents in the browser.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore })
  return NextResponse.json(await listDocuments(db, session.user.id), { headers: noStore })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore })
  const body = await request.json().catch(() => ({}))
  try {
    const created = await saveDocument(db, session.user.id, null, body && typeof body === "object" ? body : {})
    return NextResponse.json(created, { status: 201, headers: noStore })
  } catch (error) {
    if (error instanceof DocumentInputError) {
      return NextResponse.json({ error: error.message }, { status: 413, headers: noStore })
    }
    throw error
  }
}
