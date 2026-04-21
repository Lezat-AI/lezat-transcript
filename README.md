# Lezat Transcript

A local-first push-to-talk voice-to-text app for macOS, Windows, and Linux.

**Status:** v0.1 — internal preview for the Lezat team. Expect rough edges.

## Based on Handy

Lezat Transcript is a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais,
used here under the MIT License. Upstream is tracked as the `upstream` git remote.

Copyright (c) 2025 CJ Pais — original work.
Modifications (c) 2026 Lezat.

## Running from source

```bash
bun install
bun tauri dev
```

See `BUILD.md` for per-platform prerequisites (Rust toolchain, Xcode CLT on
macOS, build-essential + GTK/webkit on Linux, MSVC on Windows).

## Building a macOS DMG

```bash
bun run tauri build -- --bundles dmg
```

Output lands in `src-tauri/target/release/bundle/dmg/`.

For ad-hoc signing (no paid Apple Developer account), `tauri.conf.json` already
sets `signingIdentity: "-"`. The first launch on teammates' machines will need
right-click → Open to bypass Gatekeeper.

## Differentiator roadmap

The rebrand is step 1. Planned enhancements over upstream Handy:

- TBD — discuss with the Lezat team before cutting a v0.2.

## License

MIT. See `LICENSE` (CJ Pais's original notice is preserved).
