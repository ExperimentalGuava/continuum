// Continuum Stage-1 capture daemon — Windows.
//
// Drop-in replacement for the macOS Swift helper: emits the same NDJSON CaptureEvents on stdout,
//   {t, source, app, window_id, title?, text}
// so the entire downstream JS pipeline (segment → index → distill → MCP) runs unchanged.
//
// Event-driven: instead of polling on a timer, we install WinEvent hooks (foreground change, focus,
// value/name change) and an AddClipboardFormatListener. The daemon then sleeps in a message loop
// until Windows tells us something changed. Text-change events (re)arm a short debounce timer, so we
// capture once typing settles — not per keystroke — and a focus change captures the new surface once
// it lands. On the debounce fire we read the focused window: UIA clean text first (the body OCR can't
// see), OCR fallback for surfaces UIA can't expose, gated by a content-hash so unchanged screens are
// dropped. Clipboard fires on WM_CLIPBOARDUPDATE.
//
// Build:  cargo build --release
// Run:    target\release\continuum-capture.exe | node daemon\pipeline.mjs
mod capture;
mod ocr;
mod redact;
mod uia;

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::io::Write;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, FALSE, HGLOBAL, HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM,
};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, GetClipboardData, OpenClipboard,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetAncestor, GetForegroundWindow,
    GetMessageW, GetWindowTextW, GetWindowThreadProcessId, KillTimer, PostQuitMessage,
    RegisterClassW, SetTimer, TranslateMessage, EVENT_OBJECT_FOCUS, EVENT_OBJECT_INVOKED,
    EVENT_OBJECT_VALUECHANGE, EVENT_SYSTEM_FOREGROUND, GA_ROOT, HMENU, HWND_MESSAGE, MSG,
    WINDOW_EX_STYLE, WINDOW_STYLE,
    WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_CLIPBOARDUPDATE, WM_DESTROY, WM_TIMER,
    WNDCLASSW,
};

const CF_UNICODETEXT: u32 = 13;

// Debounce: a text/focus event (re)arms this timer; we capture only after the events go quiet. This
// is the per-keystroke fix — a burst of VALUECHANGE events collapses to one capture once typing stops.
const DEBOUNCE_MS: u32 = 600;
const TIMER_ID: usize = 1;

// The message-only window's handle, published for the WinEvent callback (a bare extern fn that can't
// capture state) so it can post the debounce timer. isize because HWND isn't Send/atomic-friendly.
static MSG_HWND: AtomicIsize = AtomicIsize::new(0);

// Per-thread capture state. The WinEvent callback and the window proc both run on the main thread
// (out-of-context hooks + timers dispatch through its message loop), so a thread-local is sound and
// lets the bare extern fns reach the Capturer without globals-with-Mutex ceremony.
thread_local! {
    static STATE: RefCell<Option<Capturer>> = const { RefCell::new(None) };
}

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

// Per-window cache cap — bounds memory over a long session (oldest window evicted when full).
const MAX_WINDOWS: usize = 512;

// FNV-1a — a cheap content signature for the UIA text-change gate (exact change, unlike OCR's fuzzy
// pHash). Lets us skip re-emitting a comms window whose text hasn't changed since last event.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() { h ^= *b as u64; h = h.wrapping_mul(0x0000_0100_0000_01b3); }
    h
}

// Record a window's new signature, evicting the oldest window if the cache is full.
fn touch(win: &mut HashMap<String, u64>, order: &mut VecDeque<String>, id: &str, sig: u64) {
    if let Some(slot) = win.get_mut(id) {
        *slot = sig;
    } else {
        if win.len() >= MAX_WINDOWS {
            if let Some(old) = order.pop_front() { win.remove(&old); }
        }
        order.push_back(id.to_string());
        win.insert(id.to_string(), sig);
    }
}

// Login / SSO surfaces — never emit (credentials get typed here). Strong markers only, so normal
// mail that merely says "sign in" isn't dropped. Covers username fields too (not just password ones).
fn is_sensitive(text: &str) -> bool {
    const MARKERS: &[&str] = &[
        "login.microsoftonline.com", "login.live.com", "officeapps.live.com/odc",
        "accounts.google.com", "okta.com", "duosecurity.com", "auth0.com",
        "no account? create one", "keep me signed in", "stay signed in",
        "enter password", "forgot password", "use a security key",
    ];
    let h = text.to_lowercase();
    MARKERS.iter().any(|m| h.contains(m))
}

fn emit_text(now: i64, source: &str, app: &str, window_id: &str, title: &str, text: &str, authored: bool, url_host: Option<&str>) {
    let mut obj = serde_json::json!({ "t": now, "source": source, "app": app, "window_id": window_id, "text": text });
    if !title.is_empty() { obj["title"] = serde_json::Value::String(title.to_string()); }
    if authored { obj["authored"] = serde_json::Value::Bool(true); }   // user is typing here → owner=me downstream
    if let Some(h) = url_host { if !h.is_empty() { obj["url_host"] = serde_json::Value::String(h.to_string()); } }
    emit(&obj);
}

// MS Office apps — capture file name + dwell only (metadata aggregate), never the document/sheet body.
fn is_office(app: &str) -> bool {
    matches!(app.to_lowercase().as_str(), "winword" | "excel" | "powerpnt")
}

// Browsers — where the work app is in the page, so we read the address bar for a url_host.
fn is_browser(app: &str) -> bool {
    matches!(app.to_lowercase().as_str(), "chrome" | "msedge" | "firefox" | "brave" | "opera" | "vivaldi")
}

// Office metadata event: the window title carries the file name; repeated emits coalesce downstream
// (same title) and accrue dwell, yielding a per-file activity aggregate without the document body.
fn emit_office(now: i64, app: &str, window_id: &str, title: &str) {
    if title.is_empty() { return; }
    emit(&serde_json::json!({ "t": now, "source": "office", "app": app, "window_id": window_id, "title": title, "text": title }));
}

// Everything the event handlers need to capture and dedup. Held in the thread-local STATE.
struct Capturer {
    uia: Option<uia::Uia>,    // None if UIA is unavailable → pure OCR (safe degrade)
    engine: ocr::Engine,
    self_app: String,
    allow: Vec<String>,
    excludes: Vec<String>,
    // Per-window change cache, FIFO-bounded so a long session can't grow it without limit.
    // value = last content signature (UIA fnv1a) or screen pHash (OCR); oldest evicted when full.
    win: HashMap<String, u64>,
    order: VecDeque<String>,
    last_clip: String,
}

impl Capturer {
    // Capture the focused window: UIA clean text first, OCR fallback. Called on the debounce fire.
    fn capture_foreground(&mut self) {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return;
        }
        let app = app_name(hwnd);
        let title = window_title(hwnd);
        let hay = format!("{app} {title}").to_lowercase(); // match allow/exclude on app + title
        let allowed = self.allow.is_empty() || self.allow.iter().any(|p| hay.contains(p));
        let skip = !allowed
            || app.to_lowercase() == self.self_app
            || self.excludes.iter().any(|e| hay.contains(e));
        if skip {
            return;
        }
        let window_id = format!("{app}|{title}");

        // Office: metadata only — emit the file name (title); dwell aggregates downstream, no body.
        if is_office(&app) {
            emit_office(now_ms(), &app, &window_id, &title);
            return;
        }

        // Is the user typing here (vs reading)? Tags the capture as authored (owner = me downstream).
        let authored = self.uia.as_ref().map_or(false, |u| u.authored_focus());
        // For browsers, read the address bar so web work apps are tagged by host, not title guessing.
        let url_host = if is_browser(&app) {
            self.uia.as_ref().and_then(|u| u.omnibox_url(hwnd))
        } else {
            None
        };

        // 1) UIA — the clean structured text (email body, chat, ticket). Primary where it works; the
        //    content OCR can't read (WebView2/RichEdit) lives here.
        if let Some(u) = &self.uia {
            // A focused password field → never capture (not even via OCR). This is the distinct
            // "suppress entirely" signal; text()==None below only means "no UIA text, try OCR".
            if u.secure_focus() {
                return;
            }
            if let Some(raw) = u.text(hwnd, 6000) {
                let text = redact::redact(&raw);
                let sig = fnv1a(&text); // exact change gate (text, not pixels)
                let changed = self.win.get(&window_id).map_or(true, |&prev| prev != sig);
                if changed && !is_sensitive(&text) {
                    touch(&mut self.win, &mut self.order, &window_id, sig);
                    if text.chars().count() >= 20 {
                        emit_text(now_ms(), "uia", &app, &window_id, &title, &text, authored, url_host.as_deref());
                    }
                }
                return; // UIA produced text → don't also OCR
            }
        }

        // 2) OCR fallback — apps whose text UIA can't expose (or UIA unavailable).
        if let Some(frame) = capture::capture(hwnd) {
            let h = capture::dhash(&frame);
            // architecture: pHash Hamming < 5 == "same screen" → skip OCR
            let changed = self
                .win
                .get(&window_id)
                .map_or(true, |&prev| capture::hamming(prev, h) >= 5);
            if changed {
                touch(&mut self.win, &mut self.order, &window_id, h);
                if let Some(raw) = self.engine.run(&frame) {
                    let text = redact::redact(&raw);
                    let t = text.trim();
                    if t.chars().count() >= 20 && !is_sensitive(t) {
                        emit_text(now_ms(), "ocr", &app, &window_id, &title, t, authored, url_host.as_deref());
                    }
                }
            }
        }
    }

    // Capture clipboard text on WM_CLIPBOARDUPDATE (deduped against the last value we emitted).
    fn capture_clipboard(&mut self) {
        if let Some(s) = clipboard_text() {
            let s = redact::redact(&s);
            if s != self.last_clip && s.chars().count() >= 3 {
                self.last_clip = s.clone();
                emit(&serde_json::json!({
                    "t": now_ms(), "source": "clipboard", "app": "Clipboard",
                    "window_id": "Clipboard", "text": s,
                }));
            }
        }
    }
}

// WinEvent callback — runs on the main thread via the message loop. It does no capture itself; it
// just (re)arms the debounce timer so a burst of events collapses to a single capture. We ignore
// background chatter (clocks, progress bars firing VALUECHANGE) by reacting only when the event's
// top-level window is the current foreground window — otherwise a busy background app could keep
// resetting the timer and starve a real capture.
unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    _event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if hwnd.0.is_null() {
        return;
    }
    let msg_hwnd = HWND(MSG_HWND.load(Ordering::Relaxed) as *mut c_void);
    if msg_hwnd.0.is_null() {
        return;
    }
    let fg = GetForegroundWindow();
    let root = GetAncestor(hwnd, GA_ROOT);
    if root.0 != fg.0 {
        return;
    }
    SetTimer(msg_hwnd, TIMER_ID, DEBOUNCE_MS, None);
}

// Window proc for the message-only window: the debounce timer and clipboard listener post here.
unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            let _ = KillTimer(hwnd, TIMER_ID); // one-shot — re-armed by the next event
            STATE.with(|s| {
                if let Some(c) = s.borrow_mut().as_mut() {
                    c.capture_foreground();
                }
            });
            LRESULT(0)
        }
        WM_CLIPBOARDUPDATE => {
            STATE.with(|s| {
                if let Some(c) = s.borrow_mut().as_mut() {
                    c.capture_clipboard();
                }
            });
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn main() {
    // WinRT (OCR async .get()) + UIA (COM) need an initialized apartment on this thread. MTA so
    // cross-process UIA/COM calls block without pumping our message queue (avoids re-entering STATE).
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let uia = uia::Uia::new(); // None if UIA is unavailable → pure OCR (safe degrade)

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

    STATE.with(|s| {
        *s.borrow_mut() = Some(Capturer {
            uia,
            engine,
            self_app,
            allow,
            excludes,
            win: HashMap::new(),
            order: VecDeque::new(),
            last_clip: String::new(),
        });
    });

    unsafe {
        let hmod = GetModuleHandleW(None).unwrap_or_default();
        let hinst = HINSTANCE(hmod.0);

        // Message-only window to receive the debounce timer + clipboard-update messages.
        let class_name: Vec<u16> = "ContinuumCaptureMsgWnd\0".encode_utf16().collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinst,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&wc);

        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            HMENU::default(),
            hinst,
            None,
        )
        .expect("create message-only window");
        MSG_HWND.store(hwnd.0 as isize, Ordering::Relaxed);

        // Clipboard: event-driven (replaces the sequence-number poll).
        let _ = AddClipboardFormatListener(hwnd);

        // WinEvent hooks (out-of-context → delivered to this thread's message loop). One for the
        // foreground/window-switch event, one spanning focus → value-change (covers name-change too).
        let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
        let _hook_fg = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            HMODULE::default(),
            Some(win_event_proc),
            0,
            0,
            flags,
        );
        let _hook_obj = SetWinEventHook(
            EVENT_OBJECT_FOCUS,
            EVENT_OBJECT_VALUECHANGE,
            HMODULE::default(),
            Some(win_event_proc),
            0,
            0,
            flags,
        );
        // Clicks/actions (button, link, menu item) — INVOKED sits outside the focus→valuechange range,
        // so a separate hook. Capturing the foreground after an action records what the click did.
        let _hook_invoke = SetWinEventHook(
            EVENT_OBJECT_INVOKED,
            EVENT_OBJECT_INVOKED,
            HMODULE::default(),
            Some(win_event_proc),
            0,
            0,
            flags,
        );

        eprintln!("continuum-capture: running (event-driven) -> NDJSON CaptureEvents on stdout");

        // Pump messages forever — timers, clipboard updates, and WinEvent callbacks all dispatch here.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
