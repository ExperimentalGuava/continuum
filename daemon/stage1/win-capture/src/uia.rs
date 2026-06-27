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
    IUIAutomationValuePattern, UIA_ButtonControlTypeId, UIA_CONTROLTYPE_ID,
    UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId, UIA_ImageControlTypeId,
    UIA_MenuBarControlTypeId, UIA_MenuControlTypeId, UIA_MenuItemControlTypeId,
    UIA_ScrollBarControlTypeId, UIA_SeparatorControlTypeId, UIA_SpinnerControlTypeId,
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

    // Meaningful text from the focused window's UIA subtree (whole-control text via TextPattern where
    // available, else element Name/Value), skipping UI chrome. None if too sparse for an episode.
    pub fn text(&self, hwnd: HWND, budget: isize) -> Option<String> {
        let root = unsafe { self.auto.ElementFromHandle(hwnd) }.ok()?;
        let mut out = String::new();
        let mut seen = HashSet::new();
        let mut remaining = budget;
        collect(&self.auto, &root, 0, &mut remaining, &mut out, &mut seen);
        let t = out.trim();
        if t.chars().count() >= 20 { Some(t.to_string()) } else { None }
    }
}

// Chrome control types whose labels are noise (buttons, menus, toolbars, tabs, scrollbars, images,
// title/status furniture). We still DESCEND into them — a toolbar may wrap real content — but don't
// collect their own Name/Value. Mirrors the macOS capture.swift CHROME_ROLES approach.
fn is_chrome(ct: UIA_CONTROLTYPE_ID) -> bool {
    const CHROME: &[UIA_CONTROLTYPE_ID] = &[
        UIA_ButtonControlTypeId, UIA_MenuBarControlTypeId, UIA_MenuItemControlTypeId,
        UIA_MenuControlTypeId, UIA_ScrollBarControlTypeId, UIA_TabControlTypeId,
        UIA_TabItemControlTypeId, UIA_ToolBarControlTypeId, UIA_TitleBarControlTypeId,
        UIA_SeparatorControlTypeId, UIA_ThumbControlTypeId, UIA_SpinnerControlTypeId,
        UIA_ImageControlTypeId, UIA_HeaderControlTypeId, UIA_HeaderItemControlTypeId,
    ];
    CHROME.contains(&ct)
}

// Keep only substantial strings (real prose, not 1-word UI labels), deduped. Strips object-
// replacement chars (U+FFFC, the image placeholders UIA returns) and collapses whitespace.
fn push_text(s: &str, out: &mut String, seen: &mut HashSet<String>, remaining: &mut isize) {
    let cleaned: String = s.chars().filter(|c| *c != '\u{FFFC}').collect();
    let t = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
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

    // Otherwise: this element's own Name + Value (unless it's chrome), then recurse into children.
    let chrome = unsafe { el.CurrentControlType() }.map(is_chrome).unwrap_or(false);
    if !chrome {
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
