# continuum-capture (Windows Stage 1)

The Windows capture daemon for Continuum. It's a drop-in replacement for the macOS Swift
helper: it emits the **same NDJSON `CaptureEvent` stream on stdout**, so the entire downstream
JS pipeline (segment → index → distill → MCP server) runs on Windows unchanged.

```
{ "t": 1719300000000, "source": "ocr", "app": "chrome",
  "window_id": "chrome|Inbox — Gmail", "title": "Inbox — Gmail", "text": "…" }
```

## How it works

OCR-first, mirroring the architecture's "change-triggered + debounced, ≤1 OCR/sec" rule:

1. **Poll the focused window** (`GetForegroundWindow`) on an adaptive 1.2s–2.8s tick.
2. **Screenshot it** via GDI `PrintWindow(PW_RENDERFULLCONTENT)` (falls back to a screen `BitBlt`),
   downscaled to ≤2600px for the OCR engine — `capture.rs`.
3. **Change-gate** with a 64-bit dHash; skip OCR when the window hasn't changed (Hamming < 5).
4. **OCR on-device** with `Windows.Media.Ocr` — no network, no model download — `ocr.rs`.
5. **Redact** card/SSN-shaped digits (`redact.rs`; Stage 2 redacts again — the canonical boundary).
6. **Emit** NDJSON; coalesce bursts and skip windows with < 20 chars of real text.

Clipboard is a `GetClipboardSequenceNumber` poll (parity with the macOS changeCount poll).

## Build & run

Prereqs: **Rust** (https://rustup.rs) and a Windows OCR language pack (English ships on most
Win10/11; otherwise Settings → Time & language → Language → add one with OCR support).

```powershell
cd daemon\stage1\win-capture
cargo build --release

# standalone smoke test — watch NDJSON scroll as you switch windows:
.\target\release\continuum-capture.exe

# wired into the pipeline (this is what `continuum start` does for you):
.\target\release\continuum-capture.exe | node ..\..\pipeline.mjs
```

Or just run **`continuum start`** from the repo root — on Windows the CLI auto-builds this crate
on first run (via `cargo`, the same way it builds the Swift helper via `swiftc` on macOS) and
pipes it into the pipeline.

## Env vars

- `CONTINUUM_EXCLUDE` — comma-separated app-name substrings never captured (set by the CLI from
  your config's `capture.exclude`). Case-insensitive. The daemon also skips its own process.

## Known limitations (v1)

- **GPU-composited surfaces** (some hardware-accelerated Chrome content) can come back black from
  `PrintWindow`. v2 fix: swap in `Windows.Graphics.Capture`. Until then OCR is best-effort there.
- **No UIA path yet.** macOS uses the accessibility tree as a cheap structured-text accelerator;
  the Windows analog (UI Automation) is a later addition. OCR is the universal path for now.
- **No audio capture** on Windows yet (macOS-only `audio.swift`).

## Validation status

Pinned to `windows = "0.58"`. The crate **type-checks clean** against that API surface, verified
by cross-compiling from macOS:

```sh
rustup target add x86_64-pc-windows-msvc
cargo check --target x86_64-pc-windows-msvc      # type-checks Windows code on any host
```

`cargo check` validates every windows-rs signature (handles, GDI, clipboard, WinRT OCR) without a
Windows SDK or linker — it just can't *run* the OCR, which is a Windows-runtime API. So a clean
check means the remaining unknowns are purely runtime: does `PrintWindow` capture real windows,
is OCR quality good, what's the perf on your hardware. Those need an actual Windows box.

Note: `PrintWindow` / `PRINT_WINDOW_FLAGS` come from `Win32::Storage::Xps` (not
`WindowsAndMessaging`) — non-obvious, and the one thing the cross-check caught.
