# CLAUDE.md — `apps/ai-broker-native-wrapper`

A **generic Tauri 2 wrapper** that ships autoinvestment.broker as a native
desktop (Windows/macOS/Linux) and mobile (Android/iOS) app. Package name
`@ai-broker/native-wrapper`. Copied from `debate/debate-ai.com`'s
`apps/debate-native-wrapper`; build instructions are in its `README.md`.

## It is not a workspace

The root `workspaces` are `["apps/ai-broker-web", "packages/*"]`, so this app
sits outside them: a root `bun install` does not install it, turbo never builds
or tests it. Install it with `bun install` inside the folder.

Its own CI is `.github/workflows/native-wrapper-ci.yml` (profile drift check,
`cargo clippy -D warnings`, `cargo test`) and `native-wrapper-release.yml`
(installers on a `native-wrapper-v*` tag).

## Things that bite

- **Rust toolchain plus the platform webview libraries are required.**
- **Generated files are checked in.** `src-tauri/tauri.conf.json`,
  `src-tauri/src/generated_scheme.rs`, `src-tauri/Info.plist`,
  `dist/splash-config.js` and `src-tauri/icons/` come from
  `profiles/ai-broker.json` via `bun run configure` / `bun run icons`. Edit the
  profile, regenerate, commit both; CI diffs them.
- **`dist/` is source here.** The root `.gitignore` ignores `**/dist/`; an
  exception keeps this app's bundled splash and settings page tracked.
- **Keep it generic.** Product behaviour belongs in `apps/ai-broker-web`; the
  wrapper takes configuration, not hardcoded assumptions. It holds no secrets.
- **Sign-in spans both apps.** The deep-link scheme (`aibroker`) is in the
  profile and in `apps/ai-broker-web/lib/native/tauri.ts`; the token handoff is
  the `oneTimeToken` plugin plus `app/auth/native-complete` and
  `app/auth/native-callback`. See the wrapper's `docs/OAUTH.md`.
- **`src-tauri/capabilities/remote.json`** lists the origins allowed to call
  native commands by hand; keep it matching the profile's `trustedOrigins`.
- Native behaviour (window, tray, deep links, shortcuts) lives in Rust, not in
  the web layer. A green build on one OS says nothing about the others.
