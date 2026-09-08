# ADR-0001: Electron shell, TypeScript engine, no Rust

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

Knowtion is downloaded and run by the user, so it is a desktop application. Three
shells were viable: Electron, Tauri v2, and a browser PWA.

A browser-only build is **disqualified for sync**, not merely inferior. Google's
GIS token model issues no refresh token and roughly one-hour access tokens that can
only be re-minted by a user gesture. Microsoft refresh tokens issued to a redirect URI
registered as type `spa` expire after 24 hours, and the same registration property
controls both CORS and lifetime, so both cannot be had at once. There is also no OS
keychain and no way to work while the window is closed. Browser storage is additionally
evictable: Safari deletes script-created data for origins unused for seven days, and
`navigator.storage.persist()` shows no prompt in Safari or Chrome.

Between Electron and Tauri, the workload decides. Knowtion is a contenteditable block
editor — exactly where "use whatever webview the OS shipped" is weakest. Tauri has open,
unfixed bugs hitting this on all three platforms: a WebView2 TSF/IME freeze on input
that already contains text, a macOS WKWebView scroll-jump on RTL keystrokes in
contenteditable (reported by a ProseMirror user), Linux IME composition rendering
outside the input (open around two years), and Compose key ignored on KDE.

## Decision

**Electron** for the shell, pinning a major version and treating the roughly 8-week
Chromium bump as a scheduled quarterly chore. The **entire engine is TypeScript** —
CRDT orchestration, packfile codec, projector, formula evaluator, query engine. No Rust.

## Consequences

- One Chromium across all three platforms. An editor bug is ours to fix by bumping
  Chromium, rather than waiting on Microsoft, Apple or a distribution.
- ~100 MB installed and higher idle RAM than Tauri. Accepted: owning the rendering
  engine is worth it for this specific workload.
- A quarterly Chromium bump is permanent and non-negotiable; Electron supports only the
  latest three majors.
- Native SQLite with real WAL, an OS keychain, filesystem watching, and no storage
  eviction.
- The TypeScript engine keeps the Electron-to-Tauri escape hatch open in both
  directions: a future Tauri host is a second adapter, not a rewrite. A Rust engine
  would foreclose that, plus a browser preview, a headless CLI and any future mobile JS
  runtime.
- No rustup or MSVC toolchain needed on the development machine.
- Loro ships a WASM binding, so the CRDT runs at native speed regardless.

## Alternatives considered

- **Tauri v2** — revisit at ~v0.5 by writing a second host adapter. Right choice only
  once the editor is stable and the team writes Rust. Deciding factor: the open
  IME/contenteditable bugs, and having no ability to ship a fix ourselves.
- **Browser PWA** — ruled out for sync and for storage durability, per Context. A web
  build can only ever be a read-only demo.
- **Rust engine** — rejected: forecloses too much optionality for a performance win the
  WASM CRDT already provides.
