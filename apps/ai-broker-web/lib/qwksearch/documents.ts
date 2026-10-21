/**
 * @fileoverview Docs storage for the Research Agent's REASON editor: the
 * `research_documents` rows behind `/api/doc/documents`.
 *
 * react-reason-editor keeps documents in the browser (`REASON-documents`) and,
 * with database sync on, mirrors each change through `grab("doc/documents")`
 * (its `useDocumentSync`). The embed points grab at qwksearch.com, so
 * `components/qwksearch/doc-storage.ts` routes those calls here instead, and
 * the documents live on the AI Broker account, as they do on debate-ai.com.
 *
 * Rows are keyed by the editor's own document id. The editor makes ids from
 * `Date.now()` and then PUTs them as if they already existed, so PUT is an
 * upsert: the first write of a document creates its row.
 *
 * Every function is scoped to one user and takes the drizzle handle, so tests
 * run it on in-memory SQLite.
 */
import { and, desc, eq, inArray } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import { researchDocuments } from "@/lib/db/schema"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = BaseSQLiteDatabase<"async", any, any>

export type ResearchDocumentRow = typeof researchDocuments.$inferSelect

/** D1 caps a row near 2 MB; refuse a document well before the write fails. */
export const MAX_DOCUMENT_CONTENT_LENGTH = 1_500_000
export const MAX_TITLE_LENGTH = 500
export const MAX_METADATA_LENGTH = 20_000

/** What the editor sends on create/update. Every field is optional. */
export interface DocumentInput {
  title?: unknown
  name?: unknown
  content?: unknown
  parentId?: unknown
  isFolder?: unknown
  isExpanded?: unknown
  metadata?: unknown
}

/** A request the editor should not retry as-is (too large, malformed). */
export class DocumentInputError extends Error {}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** A document id from a route segment or a body, or null when malformed. */
export function parseDocumentId(raw: unknown): string | null {
  const id = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw
  return typeof id === "string" && ID_PATTERN.test(id) ? id : null
}

function cleanTitle(input: DocumentInput, fallback: string): string {
  const raw = typeof input.title === "string" ? input.title : typeof input.name === "string" ? input.name : ""
  return raw.trim().slice(0, MAX_TITLE_LENGTH) || fallback
}

function cleanContent(value: unknown): string {
  const content = typeof value === "string" ? value : ""
  if (content.length > MAX_DOCUMENT_CONTENT_LENGTH) throw new DocumentInputError("Document is too large to save.")
  return content
}

/** Metadata arrives as an object (tags, isExpanded…) and is stored as JSON text. */
function cleanMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text.length > MAX_METADATA_LENGTH) throw new DocumentInputError("Document metadata is too large.")
  return text
}

/** `isExpanded` may come on its own or inside `metadata`. */
function expandedFlag(input: DocumentInput): number | undefined {
  const fromMeta =
    input.metadata && typeof input.metadata === "object"
      ? (input.metadata as { isExpanded?: unknown }).isExpanded
      : undefined
  const value = input.isExpanded ?? fromMeta
  return value === undefined ? undefined : value ? 1 : 0
}

export function listDocuments(db: DB, userId: string): Promise<ResearchDocumentRow[]> {
  return db
    .select()
    .from(researchDocuments)
    .where(eq(researchDocuments.userId, userId))
    .orderBy(desc(researchDocuments.updatedAt))
}

export async function getDocument(db: DB, userId: string, id: string): Promise<ResearchDocumentRow | null> {
  const [row] = await db
    .select()
    .from(researchDocuments)
    .where(and(eq(researchDocuments.userId, userId), eq(researchDocuments.id, id)))
    .limit(1)
  return row ?? null
}

/** A fresh id in the editor's own style (milliseconds), unique for this user. */
async function newDocumentId(db: DB, userId: string, now: Date): Promise<string> {
  let candidate = now.getTime()
  while (await getDocument(db, userId, String(candidate))) candidate += 1
  return String(candidate)
}

/**
 * Writes a document: creates it when the user has no document `id`, else
 * updates the fields present in `input`. POST passes no id and gets a new one.
 */
export async function saveDocument(
  db: DB,
  userId: string,
  id: string | null,
  input: DocumentInput,
  now: Date = new Date(),
): Promise<ResearchDocumentRow> {
  const existing = id ? await getDocument(db, userId, id) : null
  const parentId = input.parentId === undefined ? undefined : parseDocumentId(input.parentId)
  const docId = id ?? (await newDocumentId(db, userId, now))
  if (parentId === docId) throw new DocumentInputError("A document cannot be its own parent.")

  if (!existing) {
    const isFolder = input.isFolder ? 1 : 0
    const [row] = await db
      .insert(researchDocuments)
      .values({
        userId,
        id: docId,
        title: cleanTitle(input, isFolder ? "New Folder" : "Untitled"),
        content: cleanContent(input.content),
        parentId: parentId ?? null,
        isFolder,
        isExpanded: expandedFlag(input) ?? isFolder,
        metadata: cleanMetadata(input.metadata),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    return row!
  }

  const set: Partial<typeof researchDocuments.$inferInsert> = { updatedAt: now }
  if (input.title !== undefined || input.name !== undefined) set.title = cleanTitle(input, "Untitled")
  if (input.content !== undefined) set.content = cleanContent(input.content)
  if (parentId !== undefined) set.parentId = parentId
  if (input.metadata !== undefined) set.metadata = cleanMetadata(input.metadata)
  const expanded = expandedFlag(input)
  if (expanded !== undefined) set.isExpanded = expanded

  const [row] = await db
    .update(researchDocuments)
    .set(set)
    .where(and(eq(researchDocuments.userId, userId), eq(researchDocuments.id, docId)))
    .returning()
  return row!
}

/** D1 binds at most 100 parameters per statement; keep each IN list under that. */
const IN_CHUNK = 90

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK))
  return out
}

/**
 * Deletes a document, or a folder with everything under it. Resolves false
 * when the user has no such document.
 */
export async function deleteDocument(db: DB, userId: string, id: string): Promise<boolean> {
  if (!(await getDocument(db, userId, id))) return false
  const ids = new Set([id])
  let frontier = [id]
  while (frontier.length) {
    const next: string[] = []
    for (const part of chunks(frontier)) {
      const children = await db
        .select({ id: researchDocuments.id })
        .from(researchDocuments)
        .where(and(eq(researchDocuments.userId, userId), inArray(researchDocuments.parentId, part)))
      for (const child of children) {
        if (!ids.has(child.id)) {
          ids.add(child.id)
          next.push(child.id)
        }
      }
    }
    frontier = next
  }
  for (const part of chunks([...ids])) {
    await db
      .delete(researchDocuments)
      .where(and(eq(researchDocuments.userId, userId), inArray(researchDocuments.id, part)))
  }
  return true
}
