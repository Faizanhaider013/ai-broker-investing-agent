import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSession } from "@/lib/auth/session"
import {
  DocumentInputError,
  deleteDocument,
  getDocument,
  parseDocumentId,
  saveDocument,
} from "@/lib/qwksearch/documents"

const noStore = { "Cache-Control": "no-store" }
type Params = { params: Promise<{ id: string }> }

const notFound = () => NextResponse.json({ error: "Document not found" }, { status: 404, headers: noStore })
const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore })

/**
 * One of the signed-in user's Research Agent documents, by the editor's id.
 * Another user's document answers 404, the same as a missing one. PUT creates
 * the document when it doesn't exist yet (lib/qwksearch/documents.ts).
 */
export async function GET(_request: NextRequest, { params }: Params) {
  const session = await getSession()
  if (!session) return unauthorized()
  const id = parseDocumentId((await params).id)
  const doc = id === null ? null : await getDocument(db, session.user.id, id)
  return doc ? NextResponse.json(doc, { headers: noStore }) : notFound()
}

export async function PUT(request: NextRequest, { params }: Params) {
  const session = await getSession()
  if (!session) return unauthorized()
  const id = parseDocumentId((await params).id)
  if (id === null) return NextResponse.json({ error: "Invalid document id." }, { status: 400, headers: noStore })
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: noStore })
  }
  try {
    return NextResponse.json(await saveDocument(db, session.user.id, id, body), { headers: noStore })
  } catch (error) {
    if (error instanceof DocumentInputError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: noStore })
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const session = await getSession()
  if (!session) return unauthorized()
  const id = parseDocumentId((await params).id)
  const deleted = id !== null && (await deleteDocument(db, session.user.id, id))
  return deleted ? NextResponse.json({ success: true }, { headers: noStore }) : notFound()
}
