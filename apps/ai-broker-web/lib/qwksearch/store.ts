/**
 * @fileoverview Reads and writes a user's row in the `qwksearch_connections`
 * table: the linked QwkSearch account (see ./connect.ts) and the research
 * agent's preferences (see ./preferences.ts).
 *
 * Every function takes the drizzle handle so tests can run them on in-memory
 * SQLite; route handlers pass `db` from `@/lib/db`.
 */
import { eq } from "drizzle-orm"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import { qwksearchConnections } from "@/lib/db/schema"
import { parseConnection, serializeConnection, type QwkSearchConnection } from "./connect"
import { parsePreferences, serializePreferences, type QwkSearchPreferences } from "./preferences"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DB = BaseSQLiteDatabase<"async", any, any>

async function readRow(db: DB, userId: string) {
  const [row] = await db
    .select({ connection: qwksearchConnections.connection, preferences: qwksearchConnections.preferences })
    .from(qwksearchConnections)
    .where(eq(qwksearchConnections.userId, userId))
    .limit(1)
  return row ?? null
}

async function upsert(
  db: DB,
  userId: string,
  set: { connection?: string | null; preferences?: string | null },
): Promise<void> {
  const updatedAt = new Date()
  await db
    .insert(qwksearchConnections)
    .values({ userId, connection: null, preferences: null, ...set, updatedAt })
    .onConflictDoUpdate({ target: qwksearchConnections.userId, set: { ...set, updatedAt } })
}

export async function loadConnection(db: DB, userId: string): Promise<QwkSearchConnection | null> {
  return parseConnection((await readRow(db, userId))?.connection)
}

/** Stores the linked account, or with `null` unlinks it (preferences are kept). */
export async function saveConnection(db: DB, userId: string, connection: QwkSearchConnection | null): Promise<void> {
  await upsert(db, userId, { connection: serializeConnection(connection) })
}

export async function loadPreferences(db: DB, userId: string): Promise<QwkSearchPreferences> {
  return parsePreferences((await readRow(db, userId))?.preferences)
}

export async function savePreferences(db: DB, userId: string, preferences: QwkSearchPreferences): Promise<void> {
  await upsert(db, userId, { preferences: serializePreferences(preferences) })
}
