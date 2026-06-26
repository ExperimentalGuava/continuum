// Continuum Stage-1 capture daemon — Windows.
//
// Drop-in replacement for the macOS Swift helper: emits the same NDJSON CaptureEvents on stdout,
//   {t, source, app, window_id, title?, text}
// so the entire downstream JS pipeline (segment → index → distill → MCP) runs unchanged.
//
// OCR-first: on a debounced poll we screenshot the focused window, gate on a perceptual-hash
// diff (skip OCR when nothing changed), OCR the changed frame on-device, redact, and emit.
// Clipboard is a sequence-number poll, mirroring the macOS changeCount poll.
//
// Build:  cargo build --release
// Run:    target\release\continuum-capture.exe | node daemon\pipeline.mjs
mod capture;
mod ocr;
mod redact;

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, FALSE, HGLOBAL, HWND};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
};

const CF_UNICODETEXT: u32 = 13;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn emit(obj: &serde_json::Value) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{obj}"); // Value's Display is compact => one NDJSON line
    let _ = out.flush();
}

fn window_title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

// App display name = the focused window's process image stem (e.g. "chrome", "Code").
fn app_name(hwnd: HWND) -> String {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return "App".into();
        }
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) else {
            return "App".into();
        };
        let mut buf = [0u16; 260];
        let mut len = buf.len() as u32;
        let ok =
            QueryFullProcessImageNameW(h, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut len)
                .is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return "App".into();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit(['\\', '/'])
            .next()
            .map(|f| {
                let f = f.strip_suffix(".exe").or_else(|| f.strip_suffix(".EXE")).unwrap_or(f);
                f.to_string()
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "App".into())
    }
}

fn clipboard_text() -> Option<String> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let text = match GetClipboardData(CF_UNICODETEXT) {
            Ok(h) if !h.0.is_null() => {
                let p = GlobalLock(HGLOBAL(h.0)) as *const u16;
                if p.is_null() {
                    None
                } else {
                    let mut len = 0isize;
                    while *p.offset(len) != 0 {
                        len += 1;
                    }
                    let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, len as usize));
                    let _ = GlobalUnlock(HGLOBAL(h.0));
                    Some(s)
                }
            }
            _ => None,
        };
        let _ = CloseClipboard();
        text
    }
}

fn main() {
    // WinRT (OCR async .get()) needs an initialized apartment on this thread.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let Some(engine) = ocr::Engine::new() else {
        std::process::exit(1);
    };

    let self_app = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default()
        .to_lowercase();

    // Comma-separated substrings from the CLI. EXCLUDE = never captured. ALLOW = capture ONLY these
    // work apps (matched against app name + window title, so browser-based Outlook/Jira/etc. count);
    // empty ALLOW = capture everything.
    let split_env = |k: &str| -> Vec<String> {
        std::env::var(k).unwrap_or_default().split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect()
    };
    let excludes = split_env("CONTINUUM_EXCLUDE");
    let allow = split_env("CONTINUUM_ALLOW");

    // Per-window change/emit cache, FIFO-bounded so a long-running session can't grow it without
    // limit. value = (last screen hash, last emit time ms); the oldest window is evicted when full.
    let mut win: HashMap<String, (u64, i64)> = HashMap::new();
    let mut order: VecDeque<String> = VecDeque::new();
    const MAX_WINDOWS: usize = 512;
    let mut clip_seq = unsafe { GetClipboardSequenceNumber() };
    let mut last_clip = String::new();

    let base = Duration::from_millis(1200);
    let mut idle_ticks = 0u64;

    eprintln!("continuum-capture: running (OCR-first) -> NDJSON CaptureEvents on stdout");

    loop {
        let mut did_work = false;

        // --- focused-window OCR ---
        let hwnd = unsafe { GetForegroundWindow() };
        if !hwnd.0.is_null() {
            let app = app_name(hwnd);
            let title = window_title(hwnd);
            let hay = format!("{app} {title}").to_lowercase();   // match allow/exclude on app + title
            let allowed = allow.is_empty() || allow.iter().any(|p| hay.contains(p));
            let skip = !allowed
                || app.to_lowercase() == self_app
                || excludes.iter().any(|e| hay.contains(e));
            if !skip {
                if let Some(frame) = capture::capture(hwnd) {
                    let window_id = format!("{app}|{title}");
                    let h = capture::dhash(&frame);
                    // architecture: pHash Hamming < 5 == "same screen" → skip OCR
                    let changed = win
                        .get(&window_id)
                        .map_or(true, |&(prev, _)| capture::hamming(prev, h) >= 5);
                    if changed {
                        // upsert this window's hash, evicting the oldest window when the cache is full
                        if let Some(slot) = win.get_mut(&window_id) {
                            slot.0 = h;
                        } else {
                            if win.len() >= MAX_WINDOWS {
                                if let Some(old) = order.pop_front() { win.remove(&old); }
                            }
                            order.push_back(window_id.clone());
                            win.insert(window_id.clone(), (h, 0));
                        }
                        if let Some(text) = engine.run(&frame) {
                            let text = redact::redact(&text);
                            let t = text.trim();
                            let now = now_ms();
                            // coalesce bursts + skip windows with no real content (mirrors capture.swift)
                            let recent = win.get(&window_id).is_some_and(|&(_, le)| le != 0 && now - le < 400);
                            if t.chars().count() >= 20 && !recent {
                                if let Some(slot) = win.get_mut(&window_id) { slot.1 = now; }
                                let mut obj = serde_json::json!({
                                    "t": now, "source": "ocr", "app": app,
                                    "window_id": window_id, "text": t,
                                });
                                if !title.is_empty() {
                                    obj["title"] = serde_json::Value::String(title);
                                }
                                emit(&obj);
                                did_work = true;
                            }
                        }
                    }
                }
            }
        }

        // --- clipboard (sequence-number poll) ---
        let seq = unsafe { GetClipboardSequenceNumber() };
        if seq != clip_seq {
            clip_seq = seq;
            if let Some(s) = clipboard_text() {
                let s = redact::redact(&s);
                if s != last_clip && s.chars().count() >= 3 {
                    last_clip = s.clone();
                    emit(&serde_json::json!({
                        "t": now_ms(), "source": "clipboard", "app": "Clipboard",
                        "window_id": "Clipboard", "text": s,
                    }));
                    did_work = true;
                }
            }
        }

        // Adaptive backoff: responsive while active (1.2s), cheap when idle (up to ~2.8s).
        if did_work {
            idle_ticks = 0;
        } else {
            idle_ticks = (idle_ticks + 1).min(4);
        }
        sleep(base + Duration::from_millis(400 * idle_ticks));
    }
}
