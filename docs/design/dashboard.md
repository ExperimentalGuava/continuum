# Continuum Dashboard — Product Design Plan

Status: **insights + ask home shipped (v0.2)** · 2026-06-24

> This design went through several passes (wishlist → 3-tab dashboard → answer-first → four
> aesthetic variants → this). Section 11 records the journey. Sections 0–10 describe what shipped.
> The aesthetic explorations live in [`variants/`](variants/) (open the `.html` files in a browser).

## 0. North star
**Your memory, made legible — and yours.** The home answers two questions *for you*:
- **"What happened?"** — insights, surfaced proactively (a daily digest).
- **"What do I want to know?"** — ask, one input, grounded answers with cited moments.

Everything else (browse, privacy, connect) folds away. The anti-goal is making you *operate a tool*.
For something that captures everything you see, **trust is the product**, and the feeling should be
Apple-calm — a quiet, trustworthy place for your memory, not a SaaS dashboard.

## 1. Design principles
1. **Two jobs on the home: insights + ask.** Nothing else competes for the surface.
2. **Hide the complexity.** Timeline, Privacy & data, and Connect live behind one quiet `•••` menu —
   one tap away, never cluttering the home.
3. **Insights in plain language, not charts.** A sentence ("Mostly in Code and Chrome…") + a few
   hairline bars + 2–3 "worth remembering" moments. Apple Health "Summary," not a BI tool.
4. **Restraint is the aesthetic.** Near-monochrome (ink + grays), the system accent reserved for
   focus/citation only — *no brand color*. Big air, tight type, hairline rows instead of boxes.
5. **Calm and native.** Follows the system light/dark (`prefers-color-scheme`) with a manual override;
   SF-style system font; quiet motion. Looks at home on macOS.
6. **Trust is ambient & honest.** "Everything stays on this Mac" anchor; delete one tap from any
   moment; ask degrades gracefully (shows matching moments) when no model is configured.

## 2. The home (insights + ask)
- **Header:** a small `Continuum` wordmark (→ home), an appearance toggle, and a `•••` menu. That's it.
- **Greeting + date** — a calm, human anchor ("Good morning.").
- **Ask** — one large, soft input ("Ask your memory anything"), `/` to focus from anywhere.
- **Today** — a plain-language recap (LLM-written when a model is set; a factual one-liner otherwise),
  a **where-your-time-went** list (top apps, hairline bars, the top one inked), and **Worth
  remembering** — the 2–3 most salient moments, lightly tagged (*decision* / *open loop*).
- **Footer** — "🔒 Everything stays on this Mac."
- **Ask result** — replaces Today with a grounded **answer + inline `[n]` citations** that jump to the
  numbered **source moments** (or, with no model, the matching moments + an honest note). "Back to today" returns.

## 3. Hidden modes (behind `•••`)
- **Timeline** — all moments, newest-first hairline rows, with search. Tap a moment to expand + delete.
- **Privacy & data** — capture pause toggle; excluded apps (add/remove); Claude/MCP connection status;
  delete last hour / today / everything; data location. The trust center.
- **Connect to Claude** — MCP status + the one command (also surfaced in Privacy).

## 4. Visual language
Apple-calm, 2026. Near-monochrome: ink `#1d1d1f` / warm white `#fbfbfd` (light), `#f5f5f7` / near-black
`#0a0a0b` (dark); system accent (`#0071e3` / `#0a84ff`) only on the ask focus ring and citation chips;
green only for "connected"/active; red only for delete. Generous whitespace, 30px tight-tracked
headings, 56px ask field with a soft focus ring, hairline (1px) list rows — minimal containerization.
Inline SF-style stroke icons, no emoji. Follows the system appearance; manual toggle persists locally.

## 5. Insights — how the digest is built
The home's "what happened?" (`GET /api/insights`, cached by store mtime so the LLM call isn't re-run on poll):
- **Active time + time-by-app** — computed from today's episodes (factual, always).
- **Summary** — with a model: a 1–2 sentence LLM recap of today's moments. Without: a factual one-liner
  from the top apps. *(Honest degradation; the prose is the only model-gated part.)*
- **Worth remembering** — today's highest-salience moments (top 3), tagged by a light heuristic
  (*decision* / *open loop*). With a model this can later become real extraction.

## 6. Technical architecture (as built)
Local, no-network web app over `~/.continuum` — **zero runtime deps** (Node `http` + vanilla JS).
- `GET /api/state` · `GET /api/insights` · `GET /api/timeline?q=&app=&source=`
- `POST /api/ask {query}` — grounded, citation-forward; degrades to matching moments.
- `POST /api/exclude` · `POST /api/pause` · `DELETE /api/episode` · `POST /api/clear`.

State/timeline/insights read the store fresh per request; the search index and the insights digest
rebuild only when the store changes (and after any delete), so new captures/deletions appear without a
restart. Everything stays local.

## 7. Frontend decision
**Stayed vanilla** (zero-dep, no build) — the minimal language ships clean with event delegation and
inline SVG, preserving the one-command-install ethos. The whole UI is one served HTML document.

## 8. Phasing
- **v0.2 — shipped:** insights + ask home (digest, time-by-app, worth-remembering, grounded ask with
  citations + graceful degradation); Timeline; Privacy & data; follow-system theming.
- **v0.3:** conversational follow-ups on ask; weekly digest; richer "worth remembering" (LLM extraction
  of decisions / open loops / people); scheduled pause; export.
- **v1:** Graph/entity view (graph/Pro tier).

## 9. Success metrics (honest, given no telemetry)
Local-first, **no usage analytics by design**. Signal is **qualitative**: GitHub stars/issues, user
interviews, "did capture stay on after day 1," and how often people wire it into Claude (MCP). Any
future counting must be opt-in, local, and visible in Privacy.

## 10. Accessibility & safety
High-contrast light + dark; keyboard-friendly (`/` to ask, `Esc` to go back); all episode text escaped
before render; secure fields never captured upstream; the dashboard only reads the local store.

## 11. Evolution
- **v1 — wishlist:** five views + scrubber + SSE + ⌘K. Too much.
- **v2 — design crit:** cut to a focused 3-tab dashboard (Timeline/Ask/Control); fixed Ask's silent
  LLM-gating; dropped scrubber/SSE/salience-hiding; honest metrics. Still led with *browse*.
- **v3 — answer-first:** reframed around *asking* (Perplexity × Rewind); Ask became the home,
  Timeline/Control secondary; Linear/Raycast calm-dark. Closer — but still felt like an "app."
- **v4 — four aesthetic variants:** Beacon (launcher), Lens (editorial), Atlas (sidebar), Daylight
  (warm light) — in [`variants/`](variants/). Useful for comparison; all still read as SaaS.
- **v5 — insights + ask (shipped):** the home should answer *for* you (insights) and *to* you (ask),
  with everything else hidden, at Apple-level restraint (near-monochrome, hairline rows, big air,
  follows system). The brand color was the main thing making prior passes feel "appy" — removed it.
- **A real bug fixed along the way:** the time-by-app bars used `width:%` on inline `<span>`s (renders
  at 0px) — every bar had silently shown only its empty track. Fixed with `display:block`.
