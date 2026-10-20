/**
 * Detects the native app shell (apps/ai-broker-native-wrapper, a Tauri
 * webview around this site) and the one host call the site needs from it:
 * opening a URL in the system browser for the sign-in handoff. See
 * apps/ai-broker-native-wrapper/docs/OAUTH.md.
 */

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
    };
  }
}

/** The custom scheme the native app registers (its profile's `deepLinkScheme`). */
export const NATIVE_DEEP_LINK_SCHEME = "aibroker";

/** Where the system-browser half of the native sign-in handoff ends up. */
export const NATIVE_COMPLETE_PATH = "/auth/native-complete";

/** True when this page is rendered inside the native app shell. */
export function isNativeWrapper(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI__?.core);
}

/**
 * Opens `url` in the OS default browser via the wrapper's opener plugin.
 * Returns false outside the wrapper, where callers should navigate normally.
 */
export async function openInSystemBrowser(url: string): Promise<boolean> {
  if (typeof window === "undefined" || !window.__TAURI__?.core) return false;
  await window.__TAURI__.core.invoke("plugin:opener|open_url", { url });
  return true;
}

/**
 * The `redirectTo` query parameter of `search`, when it is a same-site path.
 * Anything else (absent, absolute, protocol-relative) is null, so the login
 * page cannot be used as an open redirect.
 */
export function safeRedirectPath(search: string): string | null {
  const value = new URLSearchParams(search).get("redirectTo");
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}
