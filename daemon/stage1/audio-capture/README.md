# Call transcription (Teams) — capture module

Adds awareness of voice/video calls to Continuum by transcribing them into the same pipeline the
email/Jira/Teams-message scrapers feed. **Off by default.** This directory is the *prototype* capture
path (validate first); productionization notes are at the bottom.

## ⚠️ Compliance gate — resolve before enabling capture

This is built for a **finance company**. Before any fresh audio capture:

1. **Check for the sanctioned compliance store.** Calls are very likely already recorded/transcribed
   for FINRA/SEC/MiFID II. If that store is queryable, **ingest from it instead** — most of this
   module becomes unnecessary and you avoid re-recording.
2. **Confirm consent / recording policy.** The loopback track records the *other party*. In
   two-party-consent jurisdictions, ad-hoc capture is legally fraught. This is a blocker, not a detail.

## How it captures (and why it's clean)

- **Per-process loopback**, not the full system mix — only Teams' render stream
  (`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, with
  `INCLUDE_TARGET_PROCESS_TREE` so New Teams' WebView2 children are caught).
- **Two separate tracks = free speaker separation:** mic = `speaker:"you"`, loopback =
  `speaker:"them"`. No diarization model.
- **Batch, per-utterance** (VAD-segmented), transcribed on-device (`faster-whisper`).
- **Transcribe-then-delete:** audio is streamed, never written to disk.

## Integration contract

The supervisor emits Continuum's standard NDJSON `CaptureEvent` on stdout — no new event bus:

```json
{"t": 1719600000000, "source": "audio", "app": "Teams", "window_id": "Teams|call", "speaker": "you", "text": "..."}
```

The segmenter already fuses `source:"audio"` utterances into the active visual segment
(`daemon/stage2/segmenter.mjs`), and `ownerOf` maps `speaker:"you"`→me / `"them"`→other — so with
`capture.egress: "authored"` (the default) **the remote party's words never leave the device** on the
LLM pass. Per-speaker egress is therefore enforced for free by tagging the tracks correctly.

## The three off-switches (default-off, instantly revocable)

1. **Master config** — `capture.audio` in `~/.continuum/config.json` (default `false`).
2. **Dashboard toggle / instant kill-switch** — the *Call transcription* switch in **Privacy & data**
   writes `~/.continuum/audio-off`; the daemon stops the helper within ~2s. "Off" means *no process*,
   not a quiet flag.
3. **Active-call gating** — only transcribe during an actual call (TODO: gate on the Teams call
   window via the existing UIA signal), so an open-but-idle Teams isn't captured.

Plus the egress guardrail above. Lead with this layering for the security review.

## Prototype: validate capture on the PC

> Get capture right first; transcription is the easy half.

1. **Build the loopback helper** (Developer Command Prompt):
   ```
   cl /EHsc /std:c++17 continuum_caploop.cpp ole32.lib
   ```
2. **Python deps:** `pip install numpy psutil sounddevice webrtcvad faster-whisper`
3. **Sanity-check capture in isolation** before wiring ASR: `continuum_caploop.exe <teams_pid>` should
   stream raw PCM. If `Initialize` returns `AUDCLNT_E_UNSUPPORTED_FORMAT`, request
   `WAVE_FORMAT_IEEE_FLOAT` 32-bit and convert in Python.
4. **Run the supervisor, piped into Continuum:**
   ```
   python continuum_calls.py | node bin\continuum.mjs start --stdin
   ```
   Call utterances now flow through the normal pipeline; check the dashboard feed and `continuum extract`.

## Always-on mic — voice commands + passive context (`continuum_listen.py`)

A simpler, mic-only path (no per-process loopback, no recording of other parties — just *your* voice
on *your* machine, which sidesteps most of the two-party-consent problem). One always-on stream does
two things: everything you say becomes owner=me context, and utterances starting with the wake word
**"Continuum"** are routed by the daemon to actions (set a reminder / draft an email — see
`daemon/stage4/voice.mjs`). Confirmation comes back as a toast (`daemon/notify.mjs`) and in the
dashboard Reminders/Drafts views.

```
pip install numpy sounddevice webrtcvad faster-whisper
python continuum_listen.py | node bin\continuum.mjs start --stdin
```

- **RAM** (the project's constraint): one Whisper model stays resident. `CONTINUUM_WHISPER_MODEL`
  defaults to `base.en` int8 (~150 MB); use `tiny.en` (~75 MB) for the tightest budget, `small.en`
  (~500 MB) for best accuracy. Audio is streamed, never written to disk.
- **Off-switch:** honors the dashboard **Call transcription** toggle — while `~/.continuum/audio-off`
  exists it drops frames and does no transcription, so "off" is instant and the model goes idle.
- **Wake word:** only "Continuum, …" utterances are acted on; everything else is passive context, so
  ordinary speech / a phrase like "I need to remind myself…" never triggers an action.

> Try it: with the daemon running, say *"Continuum, remind me to call the auditor on Friday"* → a
> toast confirms, and it appears under **Reminders**. *"Continuum, draft an email to Priya about the
> Q3 close"* → appears under **Drafts** to copy into Outlook.

## Productionization (after capture is validated)

For the fleet (code-sign → MSIX → Intune), don't ship a Python runtime + separate C++ exe. windows-rs
0.58 exposes the whole WASAPI loopback surface (`ActivateAudioInterfaceAsync`,
`AUDIOCLIENT_ACTIVATION_PARAMS`, `IActivateAudioInterfaceCompletionHandler`,
`AUDCLNT_STREAMFLAGS_LOOPBACK`), so fold capture into the Rust daemon as **one signed binary +
`whisper.cpp`** for ASR. The NDJSON contract above stays identical, so nothing downstream changes.

## Open items

- Active-call detection signal (window/title via the existing UIA pipeline) to drive gating.
- CPU budget on locked-down finance laptops — load-test `small.en` int8 vs `whisper.cpp` + `base`/`tiny`.
- Timestamp utterances from sample counts, not wall-clock at emit, to keep rapid back-and-forth ordered.
- Multi-party attribution on the remote side (a real diarization pass) — deferred.
