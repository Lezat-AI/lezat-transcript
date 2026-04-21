# Building Lezat Transcript

Three ways to produce installers, depending on how much you want to own
locally vs. let CI do the work.

## 1. Local dev loop (any platform)

```bash
bun install
bun tauri dev
```

Starts the app with hot-reload for the frontend. First run pulls ~500 Rust
crates and compiles whisper.cpp + ONNX Runtime — budget 15–20 min on first
build, much faster after.

## 2. Local release build (per-platform installer)

You must build on the target OS — Tauri does **not** cleanly cross-compile
because each platform links against its own native webview/audio/GUI stack.

Shared prerequisites: `rustup` (stable), `bun`, and `cmake` (for whisper.cpp).

### macOS (→ `.dmg`)

```bash
# Prereqs
xcode-select --install           # Xcode CLT
brew install cmake
rustup target add aarch64-apple-darwin x86_64-apple-darwin  # whichever you build for

# Build
bun install
bun run tauri build --bundles dmg
```

Output: `src-tauri/target/release/bundle/dmg/Lezat Transcript_<version>_aarch64.dmg`

Apple Intelligence (the `@Generable` Swift macro path) only compiles under the
**full Xcode**, not Command Line Tools. `build.rs` auto-stubs when CLT is
detected; force it off explicitly with `LEZAT_AI_STUB=1`.

Binary is ad-hoc signed. First launch on teammates' Macs needs
**right-click → Open** to bypass Gatekeeper. For notarized builds you need a
paid Apple Developer account — wire the signing identity into
`src-tauri/tauri.conf.json`.

### Windows (→ `.msi`)

```powershell
# Prereqs (one-time)
# 1. Visual Studio Build Tools 2022 with "Desktop development with C++"
# 2. Rust: https://rustup.rs/
# 3. Bun: https://bun.sh/
# 4. CMake: https://cmake.org/download/  (add to PATH)
# 5. Vulkan SDK 1.4.x: https://vulkan.lunarg.com/sdk/home#windows

# Build
bun install
bun run tauri build --bundles msi
```

Output: `src-tauri\target\release\bundle\msi\Lezat Transcript_<version>_x64_en-US.msi`

Installer is unsigned. Windows SmartScreen will warn on first run — "More
info" → "Run anyway". For trusted installers you'll need Azure Trusted
Signing or a code-signing certificate.

### Linux (→ `.deb` / `.AppImage` / `.rpm`)

```bash
# Prereqs (Ubuntu/Debian)
sudo apt update
sudo apt install -y \
    build-essential libasound2-dev pkg-config libssl-dev \
    libvulkan-dev vulkan-tools glslc \
    libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev \
    librsvg2-dev libgtk-layer-shell0 libgtk-layer-shell-dev \
    patchelf cmake

# Fedora/RHEL: see upstream `BUILD.md.handy-upstream-note` (same packages, dnf names)

# Install Rust + Bun
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://bun.sh/install | bash

# Build
bun install
bun run tauri build --bundles deb          # or: appimage, rpm, "deb,appimage"
```

Output: `src-tauri/target/release/bundle/deb/lezat-transcript_<version>_amd64.deb`

Install with `sudo dpkg -i <file>.deb` (then `sudo apt-get -f install` if
dependencies are missing).

## 3. CI builds (all three platforms, no local setup)

Push this repo to GitHub. The workflow at
`.github/workflows/lezat-release.yml` builds macOS / Windows / Linux in
parallel.

**Two ways to trigger:**

```bash
# Manual — produces artifacts you can download from the Actions run page
gh workflow run lezat-release.yml

# Tag push — also creates a draft GitHub Release with all three installers attached
git tag v0.1.1
git push origin v0.1.1
```

The CI workflow produces **unsigned** binaries — no secrets required. For
signed & notarized builds, wire in the upstream `build.yml`
(`.github/workflows/build.yml`, currently inactive) and provide
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, and
Azure Trusted Signing secrets via repo settings.

### Workflows carried over from upstream Handy

Files ending in `.handy-upstream` are the original Handy workflows, preserved
for reference (code-quality checks, Nix builds, playwright tests, the full
cross-platform signing pipeline). They don't fire under that extension. Rename
back to `.yml` to re-enable any that fit Lezat's needs.

## Troubleshooting

**`cmake: command not found`** — install cmake for your platform (brew, apt, or https://cmake.org).

**`'rustfmt' is not installed`** — `rustup component add rustfmt`.

**macOS: swiftc error about `FoundationModelsMacros`** — you're on CLT without
full Xcode. `build.rs` handles this automatically now; if you still see it,
set `LEZAT_AI_STUB=1` before building.

**Windows: MAX_PATH errors during whisper.cpp build** — set
`CARGO_TARGET_DIR=C:\t` to shorten the path.

**Linux AppImage build fails on Arch/rolling-release distros** — known
`linuxdeploy` issue with newer glibc. Build `.deb` instead and install from
that.
