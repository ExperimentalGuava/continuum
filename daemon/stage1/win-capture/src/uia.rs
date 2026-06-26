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
    IUIAutomationValuePattern, UIA_TextPatternId, UIA_ValuePatternId,
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
    // available, else element Name/Value). None if too sparse to be worth an episode.
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

// Keep only substantial strings (real prose, not 1-word UI labels), deduped — mirrors the macOS
// capture.swift extractor.
fn push_text(s: &str, out: &mut String, seen: &mut HashSet<String>, remaining: &mut isize) {
    let t = s.trim();
    let words = t.split_whitespace().count();
    let n = t.chars().count();
    if (words >= 3 || n >= 24) && n <= 5000 && !seen.contains(t) {
        seen.insert(t.to_string());
        if !out.is_empty() { out.push(' '); }
        out.push_str(t);
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

    // Otherwise: this element's own Name + Value, then recurse into its children.
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
