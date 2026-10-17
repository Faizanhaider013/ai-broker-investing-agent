/**
 * @fileoverview Runs the Research Agent's docs storage against in-memory
 * SQLite created from the real migration.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import {
  DocumentInputError,
  MAX_DOCUMENT_CONTENT_LENGTH,
  deleteDocument,
  getDocument,
  listDocuments,
  parseDocumentId,
  saveDocument,
} from "../documents"

const MIGRATION = readFileSync(join(__dirname, "../../../migrations/0022_research_documents.sql"), "utf8")

const T0 = new Date("2026-10-13T00:00:00.000Z")
const T1 = new Date("2026-10-13T00:01:00.000Z")

let db: ReturnType<typeof drizzle>

beforeEach(async () => {
  const client = createClient({ url: ":memory:" })
  await client.execute(`create table "users" ("id" text primary key)`)
  await client.execute(`insert into "users" ("id") values ('u1'), ('u2')`)
  for (const statement of MIGRATION.split("--> statement-breakpoint")) await client.execute(statement)
  db = drizzle(client)
})

describe("parseDocumentId", () => {
  it("accepts the editor's ids and stringifies numbers", () => {
    expect(parseDocumentId("1760313600000")).toBe("1760313600000")
    expect(parseDocumentId(1760313600000)).toBe("1760313600000")
    expect(parseDocumentId("doc_a-1")).toBe("doc_a-1")
  })

  it("rejects anything that is not a plain id", () => {
    for (const raw of ["", "a/b", "../x", "a b", "x".repeat(65), null, undefined, NaN, {}]) {
      expect(parseDocumentId(raw)).toBeNull()
    }
  })
})

describe("research documents", () => {
  it("creates a document on its first PUT and updates it after", async () => {
    const created = await saveDocument(db, "u1", "1001", { title: "Thesis", content: "<p>hi</p>", metadata: { tags: ["nvda"] } }, T0)
    expect(created).toMatchObject({ id: "1001", title: "Thesis", content: "<p>hi</p>", isFolder: 0, parentId: null })
    expect(JSON.parse(created.metadata!)).toEqual({ tags: ["nvda"] })

    const updated = await saveDocument(db, "u1", "1001", { content: "<p>more</p>" }, T1)
    expect(updated).toMatchObject({ id: "1001", title: "Thesis", content: "<p>more</p>" })
    expect(updated.updatedAt.getTime()).toBe(T1.getTime())
    expect(updated.createdAt.getTime()).toBe(T0.getTime())
  })

  it("gives a POSTed document a fresh id", async () => {
    await saveDocument(db, "u1", String(T0.getTime()), { title: "Taken" }, T0)
    const created = await saveDocument(db, "u1", null, { name: "Notes" }, T0)
    expect(created.id).toBe(String(T0.getTime() + 1))
    expect(created.title).toBe("Notes")
  })

  it("defaults folder titles and expands new folders", async () => {
    const folder = await saveDocument(db, "u1", "f1", { isFolder: true }, T0)
    expect(folder).toMatchObject({ title: "New Folder", isFolder: 1, isExpanded: 1 })
    const collapsed = await saveDocument(db, "u1", "f1", { metadata: { isExpanded: false } }, T1)
    expect(collapsed.isExpanded).toBe(0)
  })

  it("keeps each user's documents apart", async () => {
    await saveDocument(db, "u1", "1", { title: "Mine" }, T0)
    await saveDocument(db, "u2", "1", { title: "Theirs" }, T0)
    expect((await getDocument(db, "u1", "1"))?.title).toBe("Mine")
    expect((await getDocument(db, "u2", "1"))?.title).toBe("Theirs")
    expect(await listDocuments(db, "u1")).toHaveLength(1)
    expect(await deleteDocument(db, "u2", "1")).toBe(true)
    expect(await getDocument(db, "u1", "1")).not.toBeNull()
  })

  it("lists the most recently changed first", async () => {
    await saveDocument(db, "u1", "a", { title: "A" }, T0)
    await saveDocument(db, "u1", "b", { title: "B" }, T1)
    expect((await listDocuments(db, "u1")).map((doc) => doc.id)).toEqual(["b", "a"])
  })

  it("deletes a folder with everything under it", async () => {
    await saveDocument(db, "u1", "root", { isFolder: true }, T0)
    await saveDocument(db, "u1", "sub", { isFolder: true, parentId: "root" }, T0)
    await saveDocument(db, "u1", "leaf", { title: "Leaf", parentId: "sub" }, T0)
    await saveDocument(db, "u1", "other", { title: "Other" }, T0)
    expect(await deleteDocument(db, "u1", "root")).toBe(true)
    expect((await listDocuments(db, "u1")).map((doc) => doc.id)).toEqual(["other"])
    expect(await deleteDocument(db, "u1", "root")).toBe(false)
  })

  it("refuses oversized content and self-parenting", async () => {
    await expect(
      saveDocument(db, "u1", "big", { content: "x".repeat(MAX_DOCUMENT_CONTENT_LENGTH + 1) }, T0),
    ).rejects.toBeInstanceOf(DocumentInputError)
    await expect(saveDocument(db, "u1", "loop", { parentId: "loop" }, T0)).rejects.toBeInstanceOf(DocumentInputError)
    expect(await listDocuments(db, "u1")).toEqual([])
  })
})
