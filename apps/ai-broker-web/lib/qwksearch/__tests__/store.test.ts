/**
 * @fileoverview Runs the QwkSearch store against in-memory SQLite created
 * from the real migration, so the upserts and the migration are both checked.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import type { QwkSearchConnection } from "../connect"
import { loadConnection, loadPreferences, saveConnection, savePreferences } from "../store"

const MIGRATION = readFileSync(join(__dirname, "../../../migrations/0021_qwksearch_connections.sql"), "utf8")

const CONNECTION: QwkSearchConnection = {
  apiKey: "qwk_abc",
  user: { id: "q1", name: "Ada", email: "ada@example.com", image: null },
  plan: "free",
  upgradeUrl: "https://buy.stripe.com/x",
  connectedAt: "2026-10-13T00:00:00.000Z",
}

let db: ReturnType<typeof drizzle>

beforeEach(async () => {
  const client = createClient({ url: ":memory:" })
  await client.execute(`create table "users" ("id" text primary key)`)
  await client.execute(`insert into "users" ("id") values ('u1'), ('u2')`)
  await client.execute(MIGRATION)
  db = drizzle(client)
})

describe("qwksearch store", () => {
  it("has nothing for a user who never linked", async () => {
    expect(await loadConnection(db, "u1")).toBeNull()
    expect(await loadPreferences(db, "u1")).toEqual({})
  })

  it("links, re-links and unlinks an account per user", async () => {
    await saveConnection(db, "u1", CONNECTION)
    expect(await loadConnection(db, "u1")).toEqual(CONNECTION)
    expect(await loadConnection(db, "u2")).toBeNull()

    await saveConnection(db, "u1", { ...CONNECTION, plan: "pro" })
    expect((await loadConnection(db, "u1"))?.plan).toBe("pro")

    await saveConnection(db, "u1", null)
    expect(await loadConnection(db, "u1")).toBeNull()
  })

  it("keeps preferences when the account is unlinked, and the link when preferences change", async () => {
    await saveConnection(db, "u1", CONNECTION)
    await savePreferences(db, "u1", { maxFollowupQuestions: "3" })
    expect(await loadConnection(db, "u1")).toEqual(CONNECTION)

    await saveConnection(db, "u1", null)
    expect(await loadPreferences(db, "u1")).toEqual({ maxFollowupQuestions: "3" })
  })
})
