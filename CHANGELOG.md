# Changelog

All notable changes. Dates are when the work landed; npm releases are tagged per version.

## 0.6.0 — preferences: learn how you want your agents to work
Beyond *who you are*, Continuum now learns *how you want your agent to work for you* — the standing
instructions you'd otherwise repeat in every session ("be concise", "run the tests before the PR",
"do lightweight research and cite sources", "prefer X over Y") — and, once you approve them, applies
them to every agent automatically.
- **Open, model-agnostic engine** (`daemon/preferences.mjs`). *Stated* preferences are extracted with
  **no model at all** (free, zero-setup) from what you've actually said — canonical directive rules
  plus dynamic "Prefer X over Y", with frequency + your own authored text driving confidence, every
  candidate grounded in episode ids. *Inferred* preferences come from the configured model — **Ollama
  is decent, free and local**; a frontier model (Pro) is sharpest. Grounded JSON, never invented.
- **Human-curated, never silent.** Nothing is applied until you approve it. Curate in the dashboard's
  new **Preferences** view (Active + Suggested, with approve / edit / dismiss) or from the CLI
  (`continuum preferences`). Approved preferences live in `~/.continuum/preferences.json`.
- **Applied automatically, always free.** Approved preferences are injected into the MCP `initialize`
  instructions, so every agent session starts already knowing how you like to work — no model needed
  to *apply* them, on any tier.
- 13-assertion test; dashboard also honors `PORT`.

## 0.5.0 — MCP server, redesigned for ambient personalization
The agent now comes to *understand you* and tailor its help, deciding for itself when to reach for memory.
- **Three sharp tools** — `recall` (find specific moments; filter by time/app/source), `catch_up`
  (what you're doing now, no query), `profile` (who you are — projects, people, working style, taste).
  Built so an LLM picks the right one and uses them proactively.
- **Understanding by default** — a cheap user snapshot is injected into the MCP `initialize`
  instructions, so the agent starts every session already knowing roughly who you are.
- **Structured, attributed, scrubbed returns** with citation ids, snippet-capped to keep the agent's context lean.
- **Trust layer** — egress redaction of PII + secret-shaped strings (API keys, tokens, JWTs), honored
  app exclusions, `mcp.paused` / `mcp.sinceDays` scope, and a local audit log surfaced in the
  dashboard's Privacy view ("what your agent asked"). Read-only.
- Transport-free core (`daemon/mcp.mjs`) with a 25-assertion test. Design: `docs/architecture/mcp.md`.

## 0.4.1
- **MCP tools reframed for ambient personalization** — the `search_context` / `recent_activity`
  descriptions (and a new server-level `instructions` field) now tell the agent to use your context
  to *understand you* — what you're building, how you think and write, your taste — and tailor its
  help proactively, not just to answer explicit "what was I doing" questions.
- README onboarding leads with **hand-it-to-your-agent** (install + connect in one paste); manual
  setup is the fallback.
- GitHub About, npm description, and README aligned to the single-MCP positioning.

## 0.4.0 — capture quality + audio (verified on real data)
The round that made capture "see (and hear) the screen the way a person does."

- **Audio capture (meetings).** Opt-in (`capture.audio: true`) on-device transcription of **two
  channels** — your microphone (`you`) and system audio (`them`) — so speaker attribution is free, no
  diarization model. Meeting-gated, **transcribe-then-delete** (raw audio is never written), and
  **fused** with what's on screen into one multimodal episode. Verified live: a real call's audio
  transcribed, speaker-tagged, and bound to the Chrome window in a single episode.
- **Capture the whole window, drop the redundancy.** Whole-window capture (no more cropping) with a
  **line-level novelty filter** — the bookmark bar is captured once as context, not re-encoded every
  frame. Plus an OCR glyph-noise filter and a hard **episode-size cap**. Real-data impact:
  unique-token ratio **45% → ~83%**, runaway episodes **17k tokens → capped**, self-capture **→ 0**.
- **Silent capture.** `continuum start` no longer prints per-episode logs (which a terminal would OCR
  back into a feedback loop); `CONTINUUM_VERBOSE=1` restores them.
- **Grounded semantic labeling.** Every episode is tagged `type` (document / ai-chat / social-post /
  message / …) and `owner` (me / other), keyed on the app — labels are a closed enum, never fabricated.
- **`continuum eval` quality harness.** Measures OCR CER/WER, segmentation F1, grounding/hallucination
  rate, and end-to-end recall over checked-in fixtures — so capture changes move a number, not a vibe.
- Dashboard dark-mode text fix.

## 0.3.1 — interim
Mid-round publish of the capture-quality + audio work; superseded by 0.4.0 (audio verified working,
README reframed around the single-MCP promise).

## 0.3.0 — perception pipeline
- The **Screen Scene Graph** design (`docs/architecture/perception.md`) and its staged build: eval
  harness, AX scene-graph capture (additive), semantic labeling, cross-modal fusion, temporal
  scene diffing, and the audio helper. Reviewed against the state of the art (AX-tree gating, on-device
  vision-parser latency, MLLM hallucination) — OCR kept as the grounded floor, AX as an enricher.

## 0.2.x — the dashboard
- A new **Apple-minimal "insights + ask" dashboard** at `localhost:3939`: a daily digest of where your
  time went + ask-your-memory with cited sources, Timeline and Privacy folded behind one menu, follows
  the system light/dark. Near-monochrome, calm, zero-dependency.

## 0.1.x — initial release
- Capture → segment → index → distill pipeline; MCP server (`search_context`, `recent_activity`); CLI
  (`verify` / `start` / `dashboard` / `mcp-install`); hashed local embeddings (zero-setup, on-device).
