import { serverEnv } from "@/lib/env/runtime";

/**
 * True when the request carries the `CRON_SECRET` bearer token that
 * worker/index.ts attaches to scheduled dispatches.
 *
 * The secret is read through `serverEnv` rather than `process.env`: on
 * Cloudflare Workers a `wrangler secret` arrives on the Worker env object, and
 * `process.env.CRON_SECRET` reads undefined there — so every scheduled run was
 * rejected as an anonymous caller with a 401 and the nightly market sync never
 * ran. With no secret configured nothing matches, rather than everything.
 */
export function isCronRequest(
  authorization: string | null | undefined,
  secret: string | undefined = serverEnv("CRON_SECRET"),
): boolean {
  if (!secret || !authorization) return false;
  return timingSafeEqual(authorization, `Bearer ${secret}`);
}

/** Constant-time string comparison, so the secret cannot be guessed by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
