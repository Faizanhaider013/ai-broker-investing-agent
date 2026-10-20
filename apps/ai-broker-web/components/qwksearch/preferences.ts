/**
 * @fileoverview The research agent's own settings (follow-up questions,
 * system instructions, weather and news widgets, …) as AI Broker shows them.
 *
 * Which settings exist is research-agent-ui's call: `research-agent-ui/settings`
 * declares them as data. The ones with `scope: "client"` are read by the agent
 * from `localStorage`, one string per key, so that is where they are applied.
 * They are also saved on the user's account (`/api/qwksearch/preferences`, the
 * `qwksearch_connections.preferences` column) and copied back into
 * `localStorage` when the research page opens, so they follow the user to
 * another browser. The `scope: "server"` ones configure a QwkSearch server and
 * are managed on qwksearch.com.
 */
import { searchSettingsFields, type SettingsFieldSchema } from "research-agent-ui/settings"

export const QWKSEARCH_PREFERENCES_URL = "/api/qwksearch/preferences"

export type QwkSearchPreferences = Record<string, string>

/** The settings this app edits: research-agent-ui's client-side ones. */
export const qwksearchPreferenceFields: SettingsFieldSchema[] = searchSettingsFields.filter(
  (field) => field.scope === "client",
)

/** A field's default, as the string `localStorage` would hold. */
export function defaultPreferenceValue(field: SettingsFieldSchema): string {
  if (field.default === undefined) return field.type === "switch" ? "false" : ""
  return String(field.default)
}

/** The current value of every field: `localStorage` first, then the default. */
export function readLocalPreferences(): QwkSearchPreferences {
  const values: QwkSearchPreferences = {}
  for (const field of qwksearchPreferenceFields) {
    let stored: string | null = null
    try {
      stored = window.localStorage.getItem(field.key)
    } catch {
      // Storage blocked: fall back to the default.
    }
    values[field.key] = stored ?? defaultPreferenceValue(field)
  }
  return values
}

/**
 * Writes the known fields of `preferences` into `localStorage` and tells the
 * agent (research-agent-ui listens for `client-config-changed`).
 */
export function applyLocalPreferences(preferences: QwkSearchPreferences): void {
  let changed = false
  for (const field of qwksearchPreferenceFields) {
    const value = preferences[field.key]
    if (typeof value !== "string") continue
    try {
      window.localStorage.setItem(field.key, value)
      changed = true
    } catch {
      // Storage blocked: nothing to apply to.
    }
  }
  if (changed) window.dispatchEvent(new Event("client-config-changed"))
}

/** The preferences saved on the account, or null when signed out or unreachable. */
export async function fetchSavedPreferences(): Promise<QwkSearchPreferences | null> {
  try {
    const res = await fetch(QWKSEARCH_PREFERENCES_URL, { credentials: "same-origin" })
    if (!res.ok) return null
    const body = (await res.json()) as { preferences?: QwkSearchPreferences }
    return body.preferences ?? {}
  } catch {
    return null
  }
}

/** Saves the preferences on the account. Resolves false when that failed (e.g. signed out). */
export async function savePreferences(preferences: QwkSearchPreferences): Promise<boolean> {
  try {
    const res = await fetch(QWKSEARCH_PREFERENCES_URL, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Copies the account's saved preferences into `localStorage`, if there are any. */
export async function syncSavedPreferences(): Promise<void> {
  const saved = await fetchSavedPreferences()
  if (saved && Object.keys(saved).length) applyLocalPreferences(saved)
}
