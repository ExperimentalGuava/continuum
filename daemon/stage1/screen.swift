// Stage 1 — screen capture + OCR (the universal capture: "what you see").
//
// Screenshots the focused window with ScreenCaptureKit, runs Apple Vision OCR in reading
// order, and emits the text as NDJSON CaptureEvents — the same contract the AX helper uses,
// so the pipeline is unchanged. OCR runs ONLY when the screen meaningfully changes
// (perceptual hash), so a static window costs ~nothing.
//
// Build:  swiftc daemon/stage1/screen.swift -o daemon/stage1/screen
// Run:    ./daemon/stage1/screen | node daemon/pipeline.mjs
// Needs Screen Recording permission (System Settings → Privacy → Screen Recording).
import Foundation
import AppKit
import Vision
import CoreGraphics
import ScreenCaptureKit
import ApplicationServices

// Apps we never capture (credential managers, etc.). Extend via CONTINUUM_EXCLUDE (comma-sep).
let EXCLUDED: Set<String> = {
  var s: Set<String> = ["1Password", "Keychain Access", "Bitwarden", "Dashlane", "LastPass"]
  if let extra = ProcessInfo.processInfo.environment["CONTINUUM_EXCLUDE"] {
    for a in extra.split(separator: ",") { s.insert(a.trimmingCharacters(in: .whitespaces)) }
  }
  return s
}()

// Skip Continuum's own surfaces (the dashboard page + the terminal running `continuum start`)
// so it never captures itself. Matched on distinctive on-screen text. Includes the redesigned
// dashboard's strings (the old markers missed it → ~5% self-capture leakage in the field).
let SELF_MARKERS = ["What your machine captured", "continuum: tier=", "capture=screen embed=",
                    "Ask your memory anything", "WORTH REMEMBERING", "Everything stays on this Mac"]

// We capture the WHOLE window — a human sees the entire screen, chrome included, and the tab/
// bookmark bar carries real context ("which site am I on", "what's open"). We do NOT crop it away.
// Redundant chrome (the same bookmark bar every frame) is handled downstream by line-level novelty
// (capture it once as context, don't re-encode it each frame) — structure, not cropping.

func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
func emit(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
  print(s); fflush(stdout)
}

// Capture the frontmost app's focused on-screen window → (image, appName, windowTitle).
func captureFocusedWindow() async -> (CGImage, String, String)? {
  guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
  let appName = app.localizedName ?? "App"
  if EXCLUDED.contains(appName) { return nil }
  let pid = app.processIdentifier
  guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return nil }
  // Largest on-screen window owned by the frontmost app. Layer-agnostic on purpose: some apps
  // (Chrome especially) don't report their main window at layer 0, so requiring it dropped them.
  let mine = content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen && $0.frame.width > 100 && $0.frame.height > 100 }
  guard let window = mine.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return nil }
  let title = window.title ?? ""
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let cfg = SCStreamConfiguration()
  cfg.width = Int(window.frame.width * 2)        // retina-resolution for crisp OCR
  cfg.height = Int(window.frame.height * 2)
  cfg.showsCursor = false
  guard let img = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) else { return nil }
  return (img, appName, title)   // whole window; chrome is de-duplicated downstream, never cropped
}

// Average-hash (8×8 grayscale) for cheap "did the screen change?" detection.
func aHash(_ image: CGImage) -> UInt64 {
  let w = 8, h = 8
  var px = [UInt8](repeating: 0, count: w * h)
  guard let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return 0 }
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  let avg = px.reduce(0) { $0 + Int($1) } / (w * h)
  var hash: UInt64 = 0
  for i in 0..<64 where Int(px[i]) >= avg { hash |= (1 << UInt64(i)) }
  return hash
}
func hamming(_ a: UInt64, _ b: UInt64) -> Int { var x = a ^ b, c = 0; while x != 0 { c += 1; x &= x - 1 }; return c }

// OCR in reading order (top→bottom, left→right). Vision is near-perfect on crisp screen text.
func ocr(_ image: CGImage) -> String {
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  try? VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
  var rows: [(row: Int, x: CGFloat, text: String)] = []
  for obs in (req.results ?? []) {
    guard let s = obs.topCandidates(1).first?.string else { continue }
    rows.append((row: Int((1 - obs.boundingBox.midY) * 60), x: obs.boundingBox.minX, text: s))
  }
  rows.sort { ($0.row, $0.x) < ($1.row, $1.x) }
  var seen = Set<String>(), kept: [String] = []
  for r in rows {
    let t = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
    let words = t.split(separator: " ").count
    if (words >= 2 || t.count >= 16), t.count <= 5000, !seen.contains(t) { seen.insert(t); kept.append(t) }
  }
  return kept.joined(separator: "\n")   // preserve line structure so novelty can suppress repeated chrome
}

// --- AX focused-element capture (issue #1): the clean "user authored this" signal ---
func axAttr(_ el: AXUIElement, _ a: String) -> CFTypeRef? {
  var v: CFTypeRef?
  return AXUIElementCopyAttributeValue(el, a as CFString, &v) == .success ? v : nil
}
func axStr(_ el: AXUIElement, _ a: String) -> String? { axAttr(el, a) as? String }

// What the user is actively typing: the focused element's value (reply/email/message). Keyed on
// focus+role (stable, no DOM scraping); reliable even in browsers where the rest of the tree is
// flaky. Needs Accessibility permission; returns nil gracefully if not granted, so OCR is unaffected.
func focusedInput() -> String? {
  guard let app = NSWorkspace.shared.frontmostApplication, !EXCLUDED.contains(app.localizedName ?? "") else { return nil }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  guard let v = axAttr(axApp, kAXFocusedUIElementAttribute as String), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  let focused = v as! AXUIElement
  if axStr(focused, kAXRoleAttribute as String) == "AXSecureTextField" || axStr(focused, kAXSubroleAttribute as String) == "AXSecureTextField" { return nil }
  guard let val = axAttr(focused, kAXValueAttribute as String) as? String else { return nil }
  let t = val.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.count >= 4 ? t : nil
}

// --- Stage 1 scene graph (#7): walk the focused window's accessibility tree into a hierarchical
// region tree {role, text, children}. Additive — emitted as `scene` alongside the OCR `text`, so the
// proven capture path is untouched and the pipeline (source-agnostic) keeps reading `text`. Where AX
// is present this gives the structure a person perceives; where it's absent (gated Chromium/Electron)
// the field is simply omitted and OCR remains the floor. Bounded (depth/breadth/node budget) to stay
// within the recorder's cheap budget. Text is AX-extracted, never fabricated.
func axChildren(_ el: AXUIElement) -> [AXUIElement] { (axAttr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [] }
func axRole(_ el: AXUIElement) -> String { axStr(el, kAXRoleAttribute as String) ?? "" }
func axNodeText(_ el: AXUIElement) -> String {
  if let v = axAttr(el, kAXValueAttribute as String) as? String { return v }
  return axStr(el, kAXTitleAttribute as String) ?? axStr(el, kAXDescriptionAttribute as String) ?? ""
}
func sceneTree(_ el: AXUIElement, _ depth: Int, _ budget: inout Int) -> [String: Any]? {
  if budget <= 0 || depth > 12 { return nil }
  budget -= 1
  let role = axRole(el)
  if role == "AXSecureTextField" { return nil }                       // never capture secure fields
  let text = axNodeText(el).trimmingCharacters(in: .whitespacesAndNewlines)
  var kids: [[String: Any]] = []
  for c in axChildren(el).prefix(40) { if let n = sceneTree(c, depth + 1, &budget) { kids.append(n) } }
  if kids.isEmpty && text.isEmpty && role != "AXWebArea" { return nil }  // prune empty leaves → signal-dense
  var node: [String: Any] = ["role": role]
  if !text.isEmpty { node["text"] = String(text.prefix(2000)) }
  if !kids.isEmpty { node["children"] = kids }
  return node
}
func focusedScene() -> [String: Any]? {
  guard let app = NSWorkspace.shared.frontmostApplication, !EXCLUDED.contains(app.localizedName ?? "") else { return nil }
  let axApp = AXUIElementCreateApplication(app.processIdentifier)
  guard let w = axAttr(axApp, kAXFocusedWindowAttribute as String), CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
  var budget = 400
  return sceneTree(w as! AXUIElement, 0, &budget)
}

// Serializes captures and holds change-detection state.
actor Capturer {
  var lastHash: UInt64 = 0
  var lastText = ""
  var lastWindow = ""
  var lastInput = ""
  var busy = false

  func tick() async {
    if busy { return }
    busy = true; defer { busy = false }
    // user-authored input (issue #1) — captured independent of OCR change-detection
    if let input = focusedInput(), input != lastInput {
      lastInput = input
      let a = NSWorkspace.shared.frontmostApplication?.localizedName ?? "App"
      emit(["t": nowMs(), "source": "input", "app": a, "window_id": "\(a)|input", "text": input])
    }
    guard let (img, app, title) = await captureFocusedWindow() else { return }
    let wid = "\(app)|\(title)"
    let h = aHash(img)
    // Skip the expensive OCR only when we're on the SAME window AND the image is ~unchanged.
    // A new app, or a new page (the title changes), always re-OCRs — a coarse image hash alone
    // treats different web pages as identical and would skip them.
    if wid == lastWindow && lastHash != 0 && hamming(h, lastHash) < 3 { return }
    lastWindow = wid; lastHash = h
    let text = ocr(img)
    if text.count < 20 || text == lastText { return }
    if SELF_MARKERS.contains(where: { text.contains($0) }) { return }   // don't capture ourselves
    lastText = text
    var obj: [String: Any] = ["t": nowMs(), "source": "ocr", "app": app, "window_id": "\(app)|\(title)", "text": text]
    if !title.isEmpty { obj["title"] = title }
    if AXIsProcessTrusted(), let scene = focusedScene() { obj["scene"] = scene }   // #7: hierarchy where AX exposes it
    emit(obj)
  }
}

// --- main ---
// NSApplication init establishes the window-server (CGS) connection that ScreenCaptureKit and
// CGPreflightScreenCaptureAccess require. Without it a CLI tool asserts CGS_REQUIRE_INIT.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // background app, no Dock icon, no main window

if !CGPreflightScreenCaptureAccess() {
  CGRequestScreenCaptureAccess()
  FileHandle.standardError.write("screen: grant Screen Recording (System Settings → Privacy → Screen Recording), then re-run.\n".data(using: .utf8)!)
}
if !AXIsProcessTrusted() {
  FileHandle.standardError.write("screen: (optional) also grant Accessibility to capture what you type — System Settings → Privacy → Accessibility.\n".data(using: .utf8)!)
}

let interval = Double(ProcessInfo.processInfo.environment["CONTINUUM_OCR_INTERVAL"] ?? "2.5") ?? 2.5
let capturer = Capturer()
Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { _ in Task { await capturer.tick() } }
app.run()
