/**
 * @fileoverview How the Research Agent's REASON editor documents map between
 * the browser (`localStorage`, react-reason-editor's shape) and the
 * `research_documents` rows served by `/api/doc/documents`. Pure, so the
 * merge rules are unit-tested; `components/qwksearch/doc-storage.ts` applies
 * them in the browser.
 */

/** A document as react-reason-editor keeps it in `localStorage`. */
export interface ReasonDocument {
  id: string
  title: string
  content: string
  parentId: string | null
  children: string[]
  isExpanded: boolean
  isFolder: boolean
  tags: string[]
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

/** A row from `GET /api/doc/documents`. */
export interface DocumentRow {
  id: string
  title: string
  content: string
  parentId: string | null
  isFolder: number
  isExpanded: number
  metadata: string | null
}

function parseMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** A server row in the shape the editor keeps, as its own sync loader maps it. */
export function rowToDocument(row: DocumentRow): ReasonDocument {
  const metadata = parseMetadata(row.metadata)
  const tags = Array.isArray(metadata?.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : []
  return {
    id: String(row.id),
    title: row.title || "Untitled",
    content: row.content || "",
    parentId: row.parentId ? String(row.parentId) : null,
    children: [],
    isExpanded: row.isExpanded === 1,
    isFolder: row.isFolder === 1,
    tags,
    metadata,
  }
}

/**
 * The documents to show: every server document (the account wins on a shared
 * id) plus the ones only this browser has, which `upload` lists. A local
 * document the account had at the last sync (`seen`) but no longer has was
 * deleted on another device, so it is dropped rather than uploaded again.
 */
export function mergeDocuments(
  local: ReasonDocument[],
  remote: ReasonDocument[],
  seen: ReadonlySet<string> = new Set(),
): { documents: ReasonDocument[]; upload: ReasonDocument[] } {
  const remoteIds = new Set(remote.map((doc) => doc.id))
  const upload = local.filter(
    (doc) => doc && typeof doc.id === "string" && !remoteIds.has(doc.id) && !seen.has(doc.id),
  )
  return { documents: [...remote, ...upload], upload }
}
