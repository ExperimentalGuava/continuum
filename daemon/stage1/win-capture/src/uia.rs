// UI Automation text extraction — the clean-text path for comms apps (Outlook/Teams/Jira) whose
// content PrintWindow can't read (WebView2 / RichEdit render blank to a screenshot). UIA exposes the
// real text via the accessibility tree, so this is the PRIMARY source where it works; OCR is the
// fallback. Degrades safely: if UIA init or a query fails, we return None and the caller OCRs.
use std::collections::HashSet;
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_ButtonControlTypeId, UIA_CONTROLTYPE_ID,
    UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_HeaderControlTypeId,
    UIA_HeaderItemControlTypeId, UIA_ImageControlTypeId, UIA_MenuBarControlTypeId,
    UIA_MenuControlTypeId, UIA_MenuItemControlTypeId, UIA_ScrollBarControlTypeId,
    UIA_SeparatorControlTypeId, UIA_SpinnerControlTypeId, UIA_StatusBarControlTypeId,
    UIA_TabControlTypeId, UIA_TabItemControlTypeId, UIA_TextPatternId, UIA_ThumbControlTypeId,
    UIA_TitleBarControlTypeId, UIA_ToolBarControlTypeId, UIA_ValuePatternId,
};

pub struct Uia {
    auto: IUIAutomation,
}

impl Uia {
    pub fn new() -> Option<Uia> {
        let auto: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
        Some(Uia { auto })
    }

    // Meaningful text from the focused window. Prefer the FOCUSED element's subtree — the email body /
    // compose box / chat input the user is actually engaging with — over the whole window (folder
    // pane, ribbon, every inbox row). Biggest signal-per-effort win, and app-agnostic: the user's
    // focus IS the useful region. Falls back to the full window when focus lands on something too
    // small to be useful (e.g. just scrolling a list). None if too sparse for an episode.
    pub fn text(&self, hwnd: HWND, budget: isize) -> Option<String> {
        if let Ok(focused) = unsafe { self.auto.GetFocusedElement() } {
            // Never capture while a password / secure field has focus — don't record credentials.
            if is_password(&focused) {
                return None;
            }
            if let Some(t) = self.gather(&focused, budget) {
                if t.chars().count() >= 40 {
                    return Some(t);
                }
            }
        }
        let root = unsafe { self.auto.ElementFromHandle(hwnd) }.ok()?;
        self.gather(&root, budget)
    }

    // True if a secure (password) field currently has focus. The caller must suppress capture
    // ENTIRELY when this holds — not fall through to OCR — so typed credentials are never recorded,
    // not even as pixels. (text() also returns None on a focused password field, but None there means
    // "no UIA text → try OCR"; this is the distinct "do not capture at all" signal.)
    pub fn secure_focus(&self) -> bool {
        unsafe { self.auto.GetFocusedElement() }
            .ok()
            .map(|el| is_password(&el))
            .unwrap_or(false)
    }

    // True if the focused element is an editable surface the user is TYPING into (compose box, cell,
    // editable doc) — vs reading. Lets downstream tag the capture as authored (owner = me). An Edit
    // field is authored unless explicitly read-only; a Document only if its ValuePattern says editable
    // (so an email reading pane / read-only doc is NOT treated as authored).
    pub fn authored_focus(&self) -> bool {
        let Ok(el) = (unsafe { self.auto.GetFocusedElement() }) else { return false; };
        let ct = match unsafe { el.CurrentControlType() } { Ok(c) => c, Err(_) => return false };
        let editable = || -> Option<bool> {
            let pat = unsafe { el.GetCurrentPattern(UIA_ValuePatternId) }.ok()?;
            let vp = pat.cast::<IUIAutomationValuePattern>().ok()?;
            Some(!unsafe { vp.CurrentIsReadOnly() }.ok()?.as_bool())
        };
        if ct == UIA_EditControlTypeId {
            return editable().unwrap_or(true);    // edit field → authored unless read-only
        }
        if ct == UIA_DocumentControlTypeId {
            return editable().unwrap_or(false);   // document → authored only if explicitly editable
        }
        false
    }

    // Best-effort URL host for a browser window — read from the address bar (an Edit whose value is a
    // URL). Lets downstream reliably tag web work apps (Jira/ServiceNow/Anaplan) by host, not title
    // guessing. A bounded tree walk (the address bar sits near the top); None if not found.
    pub fn omnibox_url(&self, hwnd: HWND) -> Option<String> {
        let root = unsafe { self.auto.ElementFromHandle(hwnd) }.ok()?;
        let walker = unsafe { self.auto.ControlViewWalker() }.ok()?;
        let mut budget = 400i32;
        find_url(&walker, &root, 0, &mut budget)
    }

    fn gather(&self, el: &IUIAutomationElement, budget: isize) -> Option<String> {
        let mut out = String::new();
        let mut seen = HashSet::new();
        let mut remaining = budget;
        collect(&self.auto, el, 0, &mut remaining, &mut out, &mut seen);
        let t = out.trim();
        if t.chars().count() >= 20 { Some(t.to_string()) } else { None }
    }
}

// Chrome control types whose labels are noise (buttons, menus, toolbars, tabs, scrollbars, images,
// title/status furniture). We still DESCEND into them — a toolbar may wrap real content — but don't
// collect their own Name/Value. Mirrors the macOS capture.swift CHROME_ROLES approach.
fn is_password(el: &IUIAutomationElement) -> bool {
    unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(false)
}

fn is_chrome(ct: UIA_CONTROLTYPE_ID) -> bool {
    const CHROME: &[UIA_CONTROLTYPE_ID] = &[
        UIA_ButtonControlTypeId, UIA_MenuBarControlTypeId, UIA_MenuItemControlTypeId,
        UIA_MenuControlTypeId, UIA_ScrollBarControlTypeId, UIA_TabControlTypeId,
        UIA_TabItemControlTypeId, UIA_ToolBarControlTypeId, UIA_TitleBarControlTypeId,
        UIA_SeparatorControlTypeId, UIA_ThumbControlTypeId, UIA_SpinnerControlTypeId,
        UIA_ImageControlTypeId, UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId,
        UIA_StatusBarControlTypeId,   // drops Outlook's "This folder is up to date / Connected to…" noise
    ];
    CHROME.contains(&ct)
}

// Parse the host out of a URL-ish string (the browser address bar's value). None if it doesn't look
// like a domain — so non-URL Edit fields (search boxes, forms) don't masquerade as a url_host.
fn url_host(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() || s.contains(' ') {
        return None;
    }
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://")).unwrap_or(s);
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host); // strip any userinfo
    let host = host.split(':').next().unwrap_or(host);   // strip port
    if host.contains('.') && host.len() <= 253 && !host.is_empty() {
        Some(host.to_lowercase())
    } else {
        None
    }
}

// Bounded DFS for the first Edit element whose value is a URL (the address bar). Depth- and
// node-capped so a deep page tree can't make this expensive on every browser capture.
fn find_url(walker: &IUIAutomationTreeWalker, el: &IUIAutomationElement, depth: i32, budget: &mut i32) -> Option<String> {
    if *budget <= 0 || depth > 12 {
        return None;
    }
    *budget -= 1;
    if let Ok(ct) = unsafe { el.CurrentControlType() } {
        if ct == UIA_EditControlTypeId {
            if let Ok(pat) = unsafe { el.GetCurrentPattern(UIA_ValuePatternId) } {
                if let Ok(vp) = pat.cast::<IUIAutomationValuePattern>() {
                    if let Ok(v) = unsafe { vp.CurrentValue() } {
                        if let Some(h) = url_host(&v.to_string()) {
                            return Some(h);
                        }
                    }
                }
            }
        }
    }
    let mut child = unsafe { walker.GetFirstChildElement(el) }.ok();
    while let Some(c) = child {
        if *budget <= 0 {
            break;
        }
        if let Some(h) = find_url(walker, &c, depth + 1, budget) {
            return Some(h);
        }
        child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
    }
    None
}

// Stable UI-furniture phrases (Office ribbon, status bar, folder-pane labels) that are never real
// content — the noise that leaks in when focus is the folder pane and we fall back to the whole
// window. Matched only against SHORT strings (each is its own UIA element Name), so a long email body
// that happens to contain one of these words is never dropped.
fn is_furniture(t: &str) -> bool {
    if t.chars().count() > 80 {
        return false;
    }
    const PHRASES: &[&str] = &[
        "this folder is up to date", "all folders are up to date", "connectivity to your server",
        "connected to: microsoft exchange", "items in view", "ribbon display options",
        "quick access toolbar", "customize quick access toolbar", "minimize the folder pane",
        "minimize the ribbon", "sort, arrange or filter messages", "you have not joined any groups",
        "more commands", "text highlight color", "font color", "send/receive", "show all pinned panes",
        "hide all pinned panes", "normal view", "reading view", "click here to always preview",
        "select an item to read", "meet focused inbox", "try the new outlook",
        "change to a white background", "type to search and use the up and down arrow keys",
        "unread messages",
    ];
    let h = t.to_lowercase();
    PHRASES.iter().any(|p| h.contains(p))
}

// Keep only substantial strings (real prose, not 1-word UI labels), deduped. Strips object-
// replacement chars (U+FFFC, the image placeholders UIA returns) and collapses whitespace.
fn push_text(s: &str, out: &mut String, seen: &mut HashSet<String>, remaining: &mut isize) {
    let cleaned: String = s.chars().filter(|c| *c != '\u{FFFC}').collect();
    let t = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if is_furniture(&t) {
        return;
    }
    let words = t.split(' ').filter(|w| !w.is_empty()).count();
    let n = t.chars().count();
    if (words >= 3 || n >= 24) && n <= 5000 && !seen.contains(&t) {
        seen.insert(t.clone());
        if !out.is_empty() { out.push(' '); }
        out.push_str(&t);
        *remaining -= t.len() as isize;
    }
}

fn collect(
    auto: &IUIAutomation,
    el: &IUIAutomationElement,
    depth: i32,
    remaining: &mut isize,
    out: &mut String,
    seen: &mut HashSet<String>,
) {
    if *remaining <= 0 || depth > 24 {
        return;
    }

    // A content control (email body, message list, document) — grab its whole text and stop here.
    if let Ok(pat) = unsafe { el.GetCurrentPattern(UIA_TextPatternId) } {
        if let Ok(tp) = pat.cast::<IUIAutomationTextPattern>() {
            if let Ok(range) = unsafe { tp.DocumentRange() } {
                if let Ok(txt) = unsafe { range.GetText(8192) } {
                    let s = txt.to_string();
                    if s.trim().chars().count() >= 20 {
                        push_text(&s, out, seen, remaining);
                        return;
                    }
                }
            }
        }
    }

    // Otherwise: this element's own Name + Value (unless it's chrome or a secure field), then recurse.
    let chrome = unsafe { el.CurrentControlType() }.map(is_chrome).unwrap_or(false);
    if !chrome && !is_password(el) {
        if let Ok(name) = unsafe { el.CurrentName() } {
            push_text(&name.to_string(), out, seen, remaining);
        }
        if let Ok(pat) = unsafe { el.GetCurrentPattern(UIA_ValuePatternId) } {
            if let Ok(vp) = pat.cast::<IUIAutomationValuePattern>() {
                if let Ok(v) = unsafe { vp.CurrentValue() } {
                    push_text(&v.to_string(), out, seen, remaining);
                }
            }
        }
    }

    let walker = match unsafe { auto.ControlViewWalker() } {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut child = unsafe { walker.GetFirstChildElement(el) }.ok();
    while let Some(c) = child {
        if *remaining <= 0 {
            break;
        }
        collect(auto, &c, depth + 1, remaining, out, seen);
        child = unsafe { walker.GetNextSiblingElement(&c) }.ok();
    }
}
