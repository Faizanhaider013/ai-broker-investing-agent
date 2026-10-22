/**
 * @fileoverview Docs storage for the Research Agent's REASON editor and its
 * files sidebar: keeps the user's documents on their AI Broker account.
 *
 * react-reason-editor stores documents in `localStorage` (`REASON-documents`)
 * and, when `REASON-enable-db-sync` is on, mirrors every change through
 * `grab("doc/documents")`. The embed points grab-url at qwksearch.com, so
 * {@link installDocStorageRoute} sends those calls to this app's own
 * `/api/doc/documents` (see `lib/qwksearch/documents.ts`) instead.
 *
 * The editor never loads documents back from the server itself, so
 * {@link prepareDocStorage} does that before it mounts: it turns sync on for a
 * signed-in user, merges the account's documents into `localStorage`, and
 * uploads documents that so far only exist in this browser.
 */
import { mergeDocuments, rowToDocument, type DocumentRow, type ReasonDocument } from "@/lib/qwksearch/reason-documents"
import { QWKSEARCH_ORIGIN } from "./base-url"

export const DOCUMENTS_URL = "/api/doc/documents"

const DOCUMENTS_KEY = "REASON-documents"
const SYNC_KEY = "REASON-enable-db-sync"
/** Ids this browser last saw on the account, to tell "deleted elsewhere" from "not uploaded yet". */
const SEEN_KEY = "ai-broker-research-doc-ids"
const REMOTE_PREFIX = `${QWKSEARCH_ORIGIN}/api/doc/documents`

let routed = false

/**
 * Wraps `fetch` once so the editor's `doc/documents` calls, aimed at
 * qwksearch.com, reach this app's API with the AI Broker session cookie.
 */
export function installDocStorageRoute(): void {
  if (routed || typeof window === "undefined" || typeof window.fetch !== "function") return
  routed = true
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(REMOTE_PREFIX)) return original(input, init)
    const rest = url.slice(REMOTE_PREFIX.length)
    if (rest && !rest.startsWith("/") && !rest.startsWith("?")) return original(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.delete("x-api-key")
    headers.delete("authorization")
    return original(`${DOCUMENTS_URL}${rest}`, {
      ...init,
      method: init?.method ?? (input instanceof Request ? input.method : undefined),
      headers,
      credentials: "same-origin",
    })
  }
}

function readLocalArray<T>(key: string): T[] | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? (value as T[]) : null
  } catch {
    return null
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage blocked or full: the editor falls back to its own defaults.
  }
}

function uploadDocument(doc: ReasonDocument): Promise<unknown> {
  return fetch(`${DOCUMENTS_URL}/${encodeURIComponent(doc.id)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: doc.title || "Untitled",
      content: doc.content || "",
      parentId: doc.parentId,
      isFolder: !!doc.isFolder,
      metadata: { tags: doc.tags ?? [], isExpanded: !!doc.isExpanded, ...doc.metadata },
    }),
  }).catch(() => undefined)
}

/**
 * Loads the account's documents into the editor's storage and turns database
 * sync on, or off when the user is signed out. Never throws.
 */
export async function prepareDocStorage(): Promise<void> {
  installDocStorageRoute()
  let rows: DocumentRow[] | null = null
  try {
    const res = await fetch(DOCUMENTS_URL, { credentials: "same-origin" })
    if (res.ok) rows = (await res.json()) as DocumentRow[]
  } catch {
    rows = null
  }
  if (!Array.isArray(rows)) {
    writeLocal(SYNC_KEY, false)
    return
  }
  writeLocal(SYNC_KEY, true)

  const local = readLocalArray<ReasonDocument>(DOCUMENTS_KEY)
  const seen = new Set(readLocalArray<string>(SEEN_KEY) ?? [])
  const remote = rows.map(rowToDocument)
  const { documents, upload } = mergeDocuments(local ?? [], remote, seen)
  writeLocal(SEEN_KEY, remote.map((doc) => doc.id))
  // Nothing anywhere yet: leave storage empty so the editor seeds its welcome document.
  if (!documents.length && local === null) return
  writeLocal(DOCUMENTS_KEY, documents)
  for (const doc of upload) void uploadDocument(doc)
}
