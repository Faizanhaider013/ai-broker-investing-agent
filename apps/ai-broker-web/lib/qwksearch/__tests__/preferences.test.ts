import { describe, expect, it } from "vitest"
import {
  MAX_PREFERENCE_KEYS,
  MAX_PREFERENCE_VALUE_LENGTH,
  parsePreferences,
  sanitizePreferences,
  serializePreferences,
} from "../preferences"

describe("sanitizePreferences", () => {
  it("keeps string values and stores booleans as localStorage would", () => {
    expect(sanitizePreferences({ maxFollowupQuestions: "3", showWeatherWidget: false })).toEqual({
      maxFollowupQuestions: "3",
      showWeatherWidget: "false",
    })
  })

  it("drops malformed keys, non-string values and oversized values", () => {
    expect(
      sanitizePreferences({
        "bad key": "x",
        _private: "x",
        "1abc": "x",
        count: 3,
        nested: { a: 1 },
        huge: "x".repeat(MAX_PREFERENCE_VALUE_LENGTH + 1),
        ok: "yes",
      }),
    ).toEqual({ ok: "yes" })
  })

  it("answers {} for anything that is not a plain object", () => {
    for (const input of [null, undefined, "x", 1, ["a"]]) expect(sanitizePreferences(input)).toEqual({})
  })

  it("caps the number of entries", () => {
    const many = Object.fromEntries(Array.from({ length: MAX_PREFERENCE_KEYS + 10 }, (_, i) => [`k${i}`, "v"]))
    expect(Object.keys(sanitizePreferences(many))).toHaveLength(MAX_PREFERENCE_KEYS)
  })
})

describe("parse/serializePreferences", () => {
  it("round-trips, and stores nothing for an empty map", () => {
    const prefs = { systemInstructions: "Be brief", ttsSpeaker: "luna" }
    expect(parsePreferences(serializePreferences(prefs))).toEqual(prefs)
    expect(serializePreferences({})).toBeNull()
  })

  it("treats a missing or corrupt column as no preferences", () => {
    expect(parsePreferences(null)).toEqual({})
    expect(parsePreferences("{not json")).toEqual({})
  })
})
