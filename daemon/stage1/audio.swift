// Stage 1 (audio) — meeting capture (#10). Two channels: microphone ("you") + system audio
// ("them"), each transcribed ON-DEVICE (SFSpeechRecognizer, requiresOnDeviceRecognition) into
// utterances emitted as CaptureEvents {source:"audio", speaker} — the same NDJSON contract as
// `screen`. Capturing two channels gives speaker attribution for free (no diarization model).
// Meeting-gated; transcribe-then-delete (raw audio is never written); a 🔴 indicator while live.
//
// Build:  swiftc daemon/stage1/audio.swift -o daemon/stage1/audio
// Needs Microphone + Speech Recognition + Screen Recording (system audio) permissions.
import Foundation
import AVFoundation
import CoreMedia
import Speech
import ScreenCaptureKit
import AppKit

// Conferencing surfaces we capture in. Browser-based Meet/Teams can't be pinpointed without a URL,
// so v1 gates on app; CONTINUUM_AUDIO_FORCE=1 forces capture for testing.
let MEETING_APPS: Set<String> = ["zoom.us", "Zoom", "Microsoft Teams", "Teams", "FaceTime", "Webex", "Discord", "Slack", "Google Chrome", "Safari", "Arc"]

func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }
func emitJSON(_ o: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return }
  print(s); fflush(stdout)
}
func logErr(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

// One on-device transcription channel. On each utterance-final result it emits a speaker-labeled
// CaptureEvent and restarts the request — so audio is transcribed then dropped, never retained.
final class Channel: @unchecked Sendable {
  let speaker: String
  private let recognizer = SFSpeechRecognizer()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var latest = ""
  private var lastChange = Date()
  private var lastEmitted = ""
  init(_ speaker: String) { self.speaker = speaker }

  func start() {
    guard let recognizer = recognizer, recognizer.isAvailable else { logErr("audio: recognizer unavailable for this locale"); return }
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true                                   // stream partials so we can detect pauses
    if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }   // on-device when the locale supports it
    request = req; latest = ""; lastChange = Date()
    task = recognizer.recognitionTask(with: req) { [weak self] result, _ in
      guard let self = self, let result = result else { return }
      let t = result.bestTranscription.formattedString
      if t != self.latest { self.latest = t; self.lastChange = Date() }
      if result.isFinal { self.flush(); self.restart() }
    }
  }
  func append(_ buf: AVAudioPCMBuffer) { request?.append(buf) }
  func append(_ sb: CMSampleBuffer) { request?.appendAudioSampleBuffer(sb) }

  // Driven by the recorder's timer: when the transcript has been stable for ~1.2s (a pause = end of
  // an utterance), emit it and start a fresh request — forcing utterance boundaries instead of
  // waiting for SFSpeech's own (often-never) isFinal on a continuous stream.
  func tickFlush() { if !latest.isEmpty && Date().timeIntervalSince(lastChange) > 1.2 { flush(); restart() } }
  private func flush() {
    let t = latest.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.count >= 2 && t != lastEmitted {
      lastEmitted = t
      let app = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Meeting"
      emitJSON(["t": nowMs(), "source": "audio", "speaker": speaker, "app": app, "window_id": "\(app)|call", "text": t])
    }
  }
  private func restart() { request?.endAudio(); task?.cancel(); request = nil; task = nil; start() }
  func stop() { request?.endAudio(); task?.cancel(); request = nil; task = nil; latest = "" }
}

// System-audio tap (the "them" side) via ScreenCaptureKit — no virtual audio device required.
final class SystemAudio: NSObject, SCStreamOutput, @unchecked Sendable {
  let channel: Channel
  var stream: SCStream?
  init(_ channel: Channel) { self.channel = channel }
  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    if type == .audio { channel.append(sampleBuffer) }   // fed straight to on-device ASR; not stored
  }
  func start() async {
    guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true),
          let display = content.displays.first else { return }
    let cfg = SCStreamConfiguration()
    cfg.capturesAudio = true
    cfg.excludesCurrentProcessAudio = true
    cfg.width = 2; cfg.height = 2                          // minimal video; we only want the audio
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let s = SCStream(filter: filter, configuration: cfg, delegate: nil)
    do {
      try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "continuum.audio"))
      try await s.startCapture()
      stream = s
    } catch { logErr("audio: system-audio start failed: \(error)") }
  }
  func stop() { if let s = stream { Task { try? await s.stopCapture() } }; stream = nil }
}

// Microphone tap (the "you" side).
final class Mic: @unchecked Sendable {
  let channel: Channel
  let engine = AVAudioEngine()
  var running = false
  init(_ channel: Channel) { self.channel = channel }
  func start() {
    let input = engine.inputNode
    let fmt = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buf, _ in self?.channel.append(buf) }
    do { try engine.start(); running = true } catch { logErr("audio: mic start failed: \(error)") }
  }
  func stop() { if running { engine.inputNode.removeTap(onBus: 0); engine.stop(); running = false } }
}

// Meeting gate: capture only while a meeting app is frontmost.
final class Recorder: @unchecked Sendable {
  let you = Channel("you"), them = Channel("them")
  lazy var mic = Mic(you)
  lazy var sys = SystemAudio(them)
  var active = false
  func inMeeting() -> Bool {
    if ProcessInfo.processInfo.environment["CONTINUUM_AUDIO_FORCE"] == "1" { return true }
    guard let app = NSWorkspace.shared.frontmostApplication?.localizedName else { return false }
    return MEETING_APPS.contains(app)
  }
  func tick() {
    let want = inMeeting()
    if want && !active {
      active = true
      logErr("🔴 audio: listening (on-device, transcribe-then-delete)")
      you.start(); them.start(); mic.start(); Task { await sys.start() }
    } else if !want && active {
      active = false
      logErr("⏹ audio: stopped (left meeting)")
      mic.stop(); sys.stop(); you.stop(); them.stop()
    } else if active {
      you.tickFlush(); them.tickFlush()   // emit utterances on speech pauses
    }
  }
}

// --- main ---
let appNS = NSApplication.shared
appNS.setActivationPolicy(.accessory)

SFSpeechRecognizer.requestAuthorization { status in
  if status != .authorized { logErr("audio: grant Speech Recognition (System Settings → Privacy → Speech Recognition), then re-run.") }
}
if #available(macOS 14.0, *) {
  AVAudioApplication.requestRecordPermission { ok in if !ok { logErr("audio: grant Microphone access.") } }
} else {
  AVCaptureDevice.requestAccess(for: .audio) { ok in if !ok { logErr("audio: grant Microphone access.") } }
}
if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }

let recorder = Recorder()
Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { _ in recorder.tick() }
appNS.run()
