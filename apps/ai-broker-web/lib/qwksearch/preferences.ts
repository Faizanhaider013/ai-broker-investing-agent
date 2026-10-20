/**
 * @fileoverview The research agent's client-side preferences (follow-up
 * question count, system instructions, weather and news widgets, …) as stored
 * on the user's `qwksearch_connections` row.
 *
 * research-agent-ui reads these from `localStorage`, one string per key (the
 * fields declared with `scope: "client"` in `research-agent-ui/settings`). The
 * settings dialog writes both places, and the research page copies the stored
 * map back into `localStorage` before the agent mounts, so the choices follow
 * the user to another browser. Values stay strings, exactly as the agent reads
 * them. Pure, so it is tested without D1.
 */

export type QwkSearchPreferences = Record<string, string>

/** Bounds that keep one user's row small whatever the client sends. */
export const MAX_PREFERENCE_KEYS = 64
export const MAX_PREFERENCE_VALUE_LENGTH = 20_000

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * Keeps only well-formed entries: identifier-like keys, string or boolean
 * values (booleans become "true"/"false", as `localStorage` holds them), at
 * most {@link MAX_PREFERENCE_KEYS} of them. Anything else is dropped.
 */
export function sanitizePreferences(input: unknown): QwkSearchPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const out: QwkSearchPreferences = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PREFERENCE_KEYS) break
    if (!KEY_PATTERN.test(key)) continue
    const text = typeof value === "boolean" ? String(value) : value
    if (typeof text !== "string" || text.length > MAX_PREFERENCE_VALUE_LENGTH) continue
    out[key] = text
  }
  return out
}

export function parsePreferences(raw: string | null | undefined): QwkSearchPreferences {
  if (!raw) return {}
  try {
    return sanitizePreferences(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function serializePreferences(preferences: QwkSearchPreferences): string | null {
  const clean = sanitizePreferences(preferences)
  return Object.keys(clean).length ? JSON.stringify(clean) : null
}
