# continuum_listen.py — PROTOTYPE always-on mic listener for Continuum.
#
# Transcribes your speech on-device and emits Continuum's standard NDJSON CaptureEvents on stdout:
#   {"t": <ms>, "source": "audio", "app": "Voice", "window_id": "Voice|mic",
#    "speaker": "you", "text": "...", "authored": true}
#
# Two jobs from one always-on stream:
#   • passive context — everything you say becomes owner=me context for the companion, and
#   • voice commands — utterances that start with the wake word "Continuum" are routed by the daemon
#     to actions (set a reminder / draft an email). Nothing else is acted on.
#
# Pipe it into the pipeline (the daemon does the command routing + segmentation):
#   python continuum_listen.py | node bin/continuum.mjs start --stdin
#
# RAM (the project's constraint): ONE Whisper model stays resident — pick the smallest that's accurate
# enough. Default base.en int8 (~150 MB). tiny.en (~75 MB) for the tightest budget; small.en (~500 MB)
# for best accuracy. Set CONTINUUM_WHISPER_MODEL to choose. Audio is streamed, never written to disk.
#
# Off-switch: honors the dashboard kill-switch — while ~/.continuum/audio-off exists, it drops frames
# and does no transcription (model idle), so "off" really means not listening, instantly.
#
# Deps:  pip install numpy sounddevice webrtcvad faster-whisper
# Status/diagnostics go to STDERR so STDOUT stays a clean NDJSON stream.

import os, sys, json, time, queue
import numpy as np
import sounddevice as sd
import webrtcvad
from faster_whisper import WhisperModel

SR = 16000
FRAME_MS = 20
FRAME_BYTES = int(SR * FRAME_MS / 1000) * 2   # int16 mono
MAX_SILENCE_MS = 600                           # gap that ends an utterance

DATA = os.environ.get("CONTINUUM_DATA") or os.path.join(os.path.expanduser("~"), ".continuum")
AUDIO_OFF = os.path.join(DATA, "audio-off")
MODEL = os.environ.get("CONTINUUM_WHISPER_MODEL", "base.en")

def log(*a):
    print(*a, file=sys.stderr, flush=True)

log(f"loading whisper '{MODEL}' (int8, cpu)…")
model = WhisperModel(MODEL, device="cpu", compute_type="int8")
vad = webrtcvad.Vad(2)

def emit(text, start_t):
    text = (text or "").strip()
    if not text:
        return
    sys.stdout.write(json.dumps({
        "t": int(start_t * 1000), "source": "audio", "app": "Voice",
        "window_id": "Voice|mic", "speaker": "you", "text": text, "authored": True,
    }) + "\n")
    sys.stdout.flush()

def transcribe(frames, start_t):
    audio = np.frombuffer(b"".join(frames), np.int16).astype(np.float32) / 32768.0
    segs, _ = model.transcribe(audio, language="en")
    emit(" ".join(s.text for s in segs), start_t)

def main():
    q = queue.Queue()
    def cb(indata, n, t, status):
        q.put(bytes(indata))
    log("listening (always-on; toggle off in the dashboard to stop). ctrl-c to quit.")
    cur, silence, start_t = [], 0, None
    with sd.RawInputStream(samplerate=SR, channels=1, dtype="int16",
                           blocksize=int(SR * FRAME_MS / 1000), callback=cb):
        while True:
            f = q.get()
            if os.path.exists(AUDIO_OFF):       # kill-switch: drop everything, no transcription
                cur, silence = [], 0
                continue
            if len(f) < FRAME_BYTES:
                continue
            f = f[:FRAME_BYTES]
            voiced = vad.is_speech(f, SR)
            now = time.time()
            if voiced:
                if not cur:
                    start_t = now
                cur.append(f); silence = 0
            elif cur:
                silence += FRAME_MS
                cur.append(f)
                if silence >= MAX_SILENCE_MS:
                    transcribe(cur, start_t)
                    cur, silence = [], 0

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
