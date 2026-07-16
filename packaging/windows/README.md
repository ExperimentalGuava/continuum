# Building the Continuum Windows installer

This produces **`Continuum-Setup.exe`** — a single file a user downloads and
double-clicks. It bundles a portable Node runtime and the prebuilt capture engine, so
the user never installs Node, Rust, or Python. On install it auto-detects the user's AI
(`continuum setup --yes`) and adds Start-Menu / desktop shortcuts with the app icon.

## The easy way — GitHub Actions (no Windows PC needed)

The [`windows-installer`](../../.github/workflows/windows-installer.yml) workflow builds
everything on a Windows runner:

- **On demand:** Actions tab → *windows-installer* → *Run workflow*. Download the
  `Continuum-Setup-windows-x64` artifact when it finishes.
- **On release:** push a `v*` tag (e.g. `v0.6.0`) and the installer is built and
  attached to the GitHub Release automatically.

This is the recommended path — you don't need to own a Windows machine.

## The manual way — on a Windows PC

Prerequisites: [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and
[Inno Setup 6](https://jrsoftware.org/isdl.php).

```powershell
# 1. Build the capture engine (static CRT → no VC++ redistributable needed)
$env:RUSTFLAGS = "-C target-feature=+crt-static"
cargo build --release --manifest-path daemon/stage1/win-capture/Cargo.toml

# 2. Stage the payload into dist/continuum
node packaging/windows/make-icon.mjs
mkdir dist/continuum -Force
Copy-Item bin,examples,package.json,README.md,LICENSE,NOTICE,CHANGELOG.md dist/continuum -Recurse -Force
Copy-Item packaging/windows/continuum.ico dist/continuum -Force
robocopy daemon dist/continuum/daemon /E /XD target
mkdir dist/continuum/daemon/stage1/win-capture/target/release -Force
Copy-Item daemon/stage1/win-capture/target/release/continuum-capture.exe `
  dist/continuum/daemon/stage1/win-capture/target/release/ -Force

# 3. Add a portable Node runtime → dist/continuum/node/node.exe
#    (download node-vXX-win-x64.zip from nodejs.org, extract node.exe)

# 4. Build the installer
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" `
  "/DSrcDir=$(Resolve-Path dist/continuum)" "/DOutDir=$(Resolve-Path dist)" packaging/windows/continuum.iss
# → dist/Continuum-Setup.exe
```

## The app icon

`continuum.ico` is generated from scratch by
[`make-icon.mjs`](make-icon.mjs) — no image tools required. It also writes a
`continuum-256.png` preview. Edit the geometry/palette constants at the top of that
script to change the mark; the SVG version for the web lives at
[`docs/assets/logo.svg`](../../docs/assets/logo.svg).

## Not yet included

- **Code signing.** The installer and capture `.exe` are unsigned, so SmartScreen will
  warn on first run. The signing step is stubbed in the capture workflow; wire an
  Authenticode cert into repo secrets to enable it.
- **Python voice deps.** The mic/voice feature still needs Python installed separately;
  it stays off until then. Everything else works from the installer alone.
