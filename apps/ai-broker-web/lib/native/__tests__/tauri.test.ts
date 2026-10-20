import { afterEach, describe, expect, it } from "vitest";
import { isNativeWrapper, openInSystemBrowser, safeRedirectPath } from "../tauri";

describe("safeRedirectPath", () => {
  it("accepts a same-site path", () => {
    expect(safeRedirectPath("?redirectTo=%2Fauth%2Fnative-complete")).toBe("/auth/native-complete");
  });

  it("rejects a missing, absolute or protocol-relative target", () => {
    expect(safeRedirectPath("")).toBeNull();
    expect(safeRedirectPath("?redirectTo=https%3A%2F%2Fevil.example")).toBeNull();
    expect(safeRedirectPath("?redirectTo=%2F%2Fevil.example")).toBeNull();
    expect(safeRedirectPath("?redirectTo=%2F%5Cevil.example")).toBeNull();
    expect(safeRedirectPath("?redirectTo=javascript%3Aalert(1)")).toBeNull();
  });
});

describe("native wrapper detection", () => {
  const globalWindow = globalThis as unknown as { window?: unknown };
  const original = globalWindow.window;

  afterEach(() => {
    globalWindow.window = original;
  });

  it("is false outside the wrapper", async () => {
    globalWindow.window = {};
    expect(isNativeWrapper()).toBe(false);
    expect(await openInSystemBrowser("https://autoinvestment.broker")).toBe(false);
  });

  it("opens the system browser through the opener plugin inside the wrapper", async () => {
    const calls: unknown[][] = [];
    globalWindow.window = {
      __TAURI__: { core: { invoke: async (...args: unknown[]) => void calls.push(args) } },
    };
    expect(isNativeWrapper()).toBe(true);
    expect(await openInSystemBrowser("https://autoinvestment.broker/auth/native-complete")).toBe(true);
    expect(calls).toEqual([
      ["plugin:opener|open_url", { url: "https://autoinvestment.broker/auth/native-complete" }],
    ]);
  });
});
