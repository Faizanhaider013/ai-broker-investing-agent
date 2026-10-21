/**
 * Polymarket's Gamma API returns `clobTokenIds` as a JSON-encoded string
 * (`'["7123…", "8456…"]'`), not an array, and the database stores it the same
 * way. Indexing that string with `[0]` yields `"["`, which the token-ID check
 * then rejects — so price history was silently never synced. These helpers
 * accept either shape.
 */

const TOKEN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Parses `clobTokenIds` from an array, a JSON string, or a comma list. */
export function parseClobTokenIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  if (typeof value !== "string" || value.trim() === "") return [];

  const trimmed = value.trim();
  // `[...]` is the JSON array Gamma sends; `"..."` is that array stringified
  // a second time, which older rows in D1 contain.
  if (trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      return parseClobTokenIds(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  return trimmed
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/** True for a plausible CLOB token ID: at least 10 URL-safe characters. */
export function isValidTokenId(tokenId: unknown): tokenId is string {
  return (
    typeof tokenId === "string" &&
    tokenId.trim().length >= 10 &&
    TOKEN_ID_PATTERN.test(tokenId)
  );
}

/**
 * The first (typically "Yes") outcome's token ID, or null when the market has
 * none or it is malformed.
 */
export function firstClobTokenId(value: unknown): string | null {
  const [first] = parseClobTokenIds(value);
  return isValidTokenId(first) ? first : null;
}
