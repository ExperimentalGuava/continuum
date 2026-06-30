# continuum_calls.py — PROTOTYPE call-transcription supervisor for Continuum.
#
# Captures two tracks — the mic (you) and the Teams process loopback (them) — VAD-segments each,
# transcribes per utterance on-device, and emits Continuum's standard NDJSON CaptureEvents on stdout:
#
#     {"t": <ms>, "source": "audio", "app": "Teams", "window_id": "Teams|call",
#      "speaker": "you" | "them", "text": "..."}
#
# so it drops straight into the existing pipeline (the segmenter already fuses source:"audio" into the
# active visual segment, and ownerOf maps speaker "you" -> me / "them" -> other for the egress guard):
#
#     python continuum_calls.py | node bin/continuum.mjs start --stdin
#
# SAFETY: off by default in Continuum — this only runs when you launch it. Transcribe-then-delete:
# audio is streamed, never written to disk. Two separate tracks = free diarization (no diarization
# model). Per-speaker egress is enforced downstream: "them" utterances are owner=other and, with
# capture.egress='authored' (the default), never leave the device on the LLM pass.
#
# COMPLIANCE: read README.md before running. At a finance firm, calls are likely already recorded for
# FINRA/SEC/MiFID — ingest from that sanctioned store instead if it exists, and confirm consent /
# recording policy before any fresh capture.
#
# Status/diagnostics go to STDERR so STDOUT stays a clean NDJSON stream.

import subprocess, threading, queue, time, sys, json
import numpy as np
import psutil
import sounddevice as sd
import webrtcvad
from faster_whisper import WhisperModel

SR = 16000
FRAME_MS = 20
FRAME_BYTES = int(SR * FRAME_MS / 1000) * 2  # int16 mono

def log(*a):
    print(*a, file=sys.stderr, flush=True)

model = WhisperModel("small.en", device="cpu", compute_type="int8")

def find_teams_pid():
    for p in psutil.process_iter(["name"]):
        if p.info["name"] in ("ms-teams.exe", "Teams.exe"):
            return p.pid          # the tree flag in the C++ shim catches WebView2 children
    return None

def pcm_frames(byte_iter):
    """Yield fixed-size int16 frames from a byte stream."""
    buf = b""
    for chunk in byte_iter:
        buf += chunk
        while len(buf) >= FRAME_BYTES:
            yield buf[:FRAME_BYTES]
            buf = buf[FRAME_BYTES:]

def vad_segments(frames, speaker, out_q, max_silence_ms=600):
    """Group voiced frames into utterances, transcribe, push to queue."""
    vad = webrtcvad.Vad(2)
    cur, silence, start_t = [], 0, None
    for f in frames:
        voiced = vad.is_speech(f, SR)
        now = time.time()
        if voiced:
            if not cur:
                start_t = now
            cur.append(f); silence = 0
        elif cur:
            silence += FRAME_MS
            cur.append(f)
            if silence >= max_silence_ms:
                _emit(cur, speaker, start_t, out_q); cur, silence = [], 0
    if cur:
        _emit(cur, speaker, start_t, out_q)

def _emit(frames, speaker, start_t, out_q):
    audio = np.frombuffer(b"".join(frames), np.int16).astype(np.float32) / 32768.0
    segs, _ = model.transcribe(audio, language="en")
    text = " ".join(s.text.strip() for s in segs).strip()
    if text:
        ev = {
            "t": int(start_t * 1000),         # ms epoch — what the pipeline expects
            "source": "audio",
            "app": "Teams",
            "window_id": "Teams|call",
            "speaker": speaker,               # "you" (mic) | "them" (loopback)
            "text": text,
        }
        # The mic track IS the user authoring speech → owner=me (segmenter adds 'input' to source_mix).
        # The loopback track stays owner=other, so the remote party's words don't egress by default.
        if speaker == "you":
            ev["authored"] = True
        out_q.put(ev)

def proc_loopback_bytes(pid):
    proc = subprocess.Popen(["continuum_caploop.exe", str(pid)],
                            stdout=subprocess.PIPE, bufsize=0)
    try:
        while True:
            data = proc.stdout.read(FRAME_BYTES * 4)
            if not data:
                break
            yield data
    finally:
        proc.terminate()

def mic_bytes():
    q = queue.Queue()
    def cb(indata, frames, t, status):
        q.put(bytes(indata))
    with sd.RawInputStream(samplerate=SR, channels=1, dtype="int16",
                           blocksize=int(SR * FRAME_MS / 1000), callback=cb):
        while True:
            yield q.get()

def run():
    pid = find_teams_pid()
    if pid is None:
        log("Teams not running — start a call first.")
        return
    log(f"capturing call audio (Teams pid {pid}); ctrl-c to stop")
    out_q = queue.Queue()
    threading.Thread(target=vad_segments,
                     args=(pcm_frames(mic_bytes()), "you", out_q), daemon=True).start()
    threading.Thread(target=vad_segments,
                     args=(pcm_frames(proc_loopback_bytes(pid)), "them", out_q),
                     daemon=True).start()
    # Emit NDJSON CaptureEvents to stdout — pipe into `node bin/continuum.mjs start --stdin`.
    while True:
        u = out_q.get()
        sys.stdout.write(json.dumps(u) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    run()
