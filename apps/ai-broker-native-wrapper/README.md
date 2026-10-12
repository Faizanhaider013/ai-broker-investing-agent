# ai-broker-native-wrapper

A [Tauri 2](https://tauri.app) shell that ships [autoinvestment.broker](https://autoinvestment.broker)
as a native app for **Windows, macOS, Linux, Android and iOS**. It opens a window on the live
site and adds the OS plumbing a plain webview lacks: a real app icon and identity on every
platform, Google sign-in through the system browser (Google blocks embedded webviews), a system
tray with minimize-to-tray, launch on login, and a fullscreen toggle.

Copied from `debate/debate-ai.com`'s `apps/debate-native-wrapper` and retargeted with a new
profile, `profiles/ai-broker.json`. The Rust side is generic: everything product-specific comes
from that profile.

## What this is not

Not a place for trading UI or logic. The wrapped site provides all of that, from
`apps/ai-broker-web`. This package stops at: open a window at the configured URL, register the
app's identity with each OS, get a browser-based sign-in back into that window, and answer the
site when it asks what machine it is running on (`src-tauri/src/system_info.rs`).

## It is not a workspace

The root `workspaces` are `apps/ai-broker-web` and `packages/*`, so this folder sits outside
them: a root `bun install` does not install it, turbo never builds or tests it, and
`bun run build` / `bun run test` at the root never reach it. Install and build it from here. Its
own CI is `.github/workflows/native-wrapper-ci.yml` (profile drift check, `cargo clippy`,
`cargo test`) and `native-wrapper-release.yml` (signed installers on a tag).

## Layout

```
ai-broker-native-wrapper/
├── profiles/
│   ├── ai-broker.json      # the profile this repo ships: name, bundle id, URL, deep-link scheme
│   └── example.json        # template for pointing the wrapper at another site
├── dist/                   # bundled frontend: launch splash (index.html + splash.png) and settings page
├── scripts/
│   ├── configure.mjs       # profile -> tauri.conf.json, generated_scheme.rs, Info.plist, splash-config.js
│   ├── generate-icons.mjs  # profile iconSource -> full src-tauri/icons/ set
│   └── build-docker.sh     # Linux / Android / iOS-core builds in Docker
├── src-tauri/              # the Rust app (window, tray, deep links, shortcuts, media permissions)
├── docker/                 # Dockerfiles used by build-docker.sh
└── docs/                   # BUILDING, PLATFORMS, MOBILE, APP_STORES, OAUTH, DOCKER_BUILDING
```

`src-tauri/tauri.conf.json`, `src-tauri/src/generated_scheme.rs`, `src-tauri/Info.plist`,
`dist/splash-config.js` and `src-tauri/icons/` are generated from the profile and checked in.
Edit the profile, then run `bun run configure` (and `bun run icons` if the icon changed); CI
fails if the checked-in files drift from the profile.

## Prerequisites (every platform)

1. **Rust** (stable): `curl https://sh.rustup.rs -sSf | sh`
2. **Bun** 1.3+ (or Node 20+ for the scripts).
3. Install this package's own dependencies (the Tauri CLI):

   ```bash
   cd apps/ai-broker-native-wrapper
   bun install
   ```

Every `dev` / `build` script runs `scripts/configure.mjs` first, so the generated config always
matches the active profile.

## Build for desktop

Build on the OS you are targeting; Tauri does not cross-compile desktop installers.

**Linux** (Debian/Ubuntu; other distros are in `docs/PLATFORMS.md`):

```bash
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
bun run build:desktop                             # .deb, .rpm and .AppImage
bun run build:desktop -- --bundles deb,appimage   # or just the formats you want
```

A Linux build only runs on distros at least as new as the one that built it (glibc), so build
release packages on the oldest distro you support, or use `bun run docker:build:linux`
(Ubuntu 22.04).

**macOS** (needs Xcode Command Line Tools: `xcode-select --install`):

```bash
bun run build:desktop                                    # .app and .dmg for this Mac's arch
rustup target add aarch64-apple-darwin x86_64-apple-darwin
bun run build:desktop -- --target universal-apple-darwin  # one build for Intel + Apple Silicon
```

**Windows** (needs [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with "Desktop development with C++"; WebView2 ships with Windows 10/11):

```powershell
bun run build:desktop       # .exe (NSIS) and .msi
```

Output lands in `src-tauri/target/release/bundle/` (or `target/<triple>/release/bundle/` with
`--target`). For a live window while developing, run `bun run dev`.

## Build for Android

Requirements: Android Studio (or the SDK command-line tools), **NDK r28+**, and a JDK 17.

```bash
export ANDROID_HOME="$HOME/Android/Sdk"                 # macOS: $HOME/Library/Android/sdk
export NDK_HOME="$ANDROID_HOME/ndk/<version>"
export JAVA_HOME="/path/to/jdk-17"                      # Android Studio's bundled JBR works
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

bun run android:init     # once per checkout: generates src-tauri/gen/android
bun run android:dev      # run on a connected device or emulator
bun run android:build    # release .aab for Google Play
bun run android:build -- --apk   # plain .apk to sideload
```

Output is under `src-tauri/gen/android/app/build/outputs/` (`bundle/` for `.aab`, `apk/` for
`.apk`). A release build must be signed before Play accepts it: generate an upload keystore once
with `keytool -genkey -v -keystore release.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000`
and keep it safe (losing it means you can never update the listing). Without Android tooling
installed, `bun run docker:build:android` builds inside a container. See `docs/MOBILE.md`.

## Build for iOS

Requirements: a **Mac** with full **Xcode** (not just the Command Line Tools), CocoaPods
(`brew install cocoapods`), and an Apple Developer account for anything beyond the simulator.

```bash
rustup target add aarch64-apple-ios x86_64-apple-ios aarch64-apple-ios-sim

bun run ios:init         # once per checkout: generates src-tauri/gen/apple
bun run ios:dev          # run in the simulator or on a connected device
bun run ios:build -- --export-method app-store-connect   # or ad-hoc / development
```

Before the first device or App Store build, open `src-tauri/gen/apple/*.xcodeproj` in Xcode and
pick your Team under Signing & Capabilities. The `.ipa` lands under `src-tauri/gen/apple/build/`.
Apple reviews thin webview wrappers strictly (Guideline 4.2, minimum functionality); read
`docs/APP_STORES.md` before submitting.

## Release builds from CI

Push a tag such as `native-wrapper-v1.0.0` (or run **Native Wrapper Release** manually) and
`.github/workflows/native-wrapper-release.yml` builds Windows, macOS (universal), Linux, a
best-effort Android `.aab` and a best-effort iOS `.ipa`, attached to a draft GitHub Release.
Every signing secret is optional; a platform whose secrets are missing builds unsigned instead
of failing.

| Secret | Enables |
| --- | --- |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Signing the macOS app (base64 `.p12`, Developer ID Application). |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarizing it (`APPLE_PASSWORD` is an app-specific password). |
| `IOS_PROVISIONING_PROFILE_BASE64` | The signed iOS `.ipa`. |
| `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Authenticode-signing the `.exe` / `.msi` (base64 `.pfx`). |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Release-signing the Android `.aab`. |

Store submission (Microsoft Store, Mac App Store, App Store, Google Play) is in
`docs/APP_STORES.md`.

## Sign-in

Google refuses OAuth inside embedded webviews, so inside the app the login page shows one
**Continue in your browser** button. The browser signs in at `/auth/native-complete` (Google or
wallet), mints a single-use token, and hands it back over the `aibroker://` deep link; the app
window spends it at `/auth/native-callback` and is signed in. The site half lives in
`apps/ai-broker-web` (`lib/native/tauri.ts`, `app/auth/native-*`, the `oneTimeToken` plugin in
`lib/auth/index.ts`). Full walkthrough: `docs/OAUTH.md`.

## Configuration

The app reads no environment variables and holds no secrets: broker and LLM keys stay on the
Worker, never in the app. Its identity comes from the profile:

| Field | What it sets |
| --- | --- |
| `url` | The site the window loads. Point it at `http://localhost:3000` to test a local `apps/ai-broker-web`, and don't commit that. |
| `appName`, `productName`, `identifier`, `version` | The app's identity with each OS and store. Never change `identifier` after a store release. |
| `deepLinkScheme` | The scheme the sign-in handoff returns on (`aibroker`). Keep it in sync with `NATIVE_DEEP_LINK_SCHEME` in `apps/ai-broker-web/lib/native/tauri.ts`. |
| `iconSource` | The PNG `bun run icons` expands into `src-tauri/icons/` (currently the site's 512px Android icon; a 1024px source would be sharper). |
| `sources`, `defaultSource` | Where the app can load from; the user picks in the settings page or the tray's **Load From** menu. |
| `trustedOrigins` | Origins allowed to call the app's native commands. Also listed in `src-tauri/capabilities/remote.json`; keep both to domains you control. |
| `window`, `android`, `ios` | Window geometry, package name, bundle id, OS floors. |

`WRAPPER_PROFILE=<name>` selects a different `profiles/<name>.json` for `configure` and `icons`;
`profiles/README.md` documents every field.
