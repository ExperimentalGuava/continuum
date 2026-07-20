# Continuum ingestion pipeline

By redpropriety and Claude

Status: design draft · Last updated: 2026-07-17

How Continuum ingests work you do on a laptop (screen, accessibility tree, audio, clipboard, files) and turns it into durable, queryable knowledge without running a local LLM.


## The one law

Capture must be microsecond-cheap and never block.

## Capturing Events (Stage 1)

The continuum system begins at the capturing of events on the machine. These events are of specific kinds and listed here:

UIA - Windows UI Automation text. Change events are debounced, then the focused window is read and text is extracted.

OCR - Used to capture pixels on screen if UIA captures nil.

Clipboard - Copied text is extracted.

File - File saves in accordingly configured directories. When a file is updated, the text is extracted.

Audio - Optional mic + system audio are transcribed on-device into speaker-tagged lines which are extracted.

The above represent the means in which continuum in stage 1 collects data segments. 


## Volume reduction is the whole trick (Accross all stages)

The expensive step runs ~ 1000× less often than the cheap step. That is what makes "track everything" scalable.

## Capturing information is based off events, not intervals. (Stage 1)

We don't poll at a fixed interval. Human context changes on second timescales,not milliseconds; a high-frequency poll just captures redundant frames.

Reagrding Mac, we're event-driven where the OS provides it: `AXObserver` notifications

`FSEvents`, pasteboard change-count, app-activation. ~0 cost when idle.

Change triggered + debounced for the screen: OCR only when the accessibility tree can't read the app and pixels meaningfully changed (perceptual-hash diff). Hard-cap (≤1 OCR/sec).

Streaming for audio: on-device transcription during calls only.


## Boundaries between segments (Stage 2)

Hard (structural): app switch, window/doc/URL-host change, idle gap, lock/wake, calendar meeting edges.

Soft (semantic): rolling content embedding drifts past a cosine threshold from the segment centroid (same app, new subject).

Put simply: as capture events stream into stage 2, each event's text is embedded and compared (cosine similarity) against the running average of the current segment's content. When similarity to that centroid falls below a threshold, the system takes it as a topic change. The segment is closed and a new one begins.

## Two tiers of segmentation (lambda/kappa pattern) (Stage 2)

Tier A (online, deterministic, no LLM): produces candidate segments in real time.
  
They are immediately embeddable. Per-window accumulators (split attention / two monitors).

Tier B (batch, on idle): re-segments — merges over-split fragments, splits on runs.
  
Occurs via embedding change point detection; daily rollup may use one LLM call to group segments into a work block. Corrects Tier A before anything expensive runs.

## Online loop (Stage 2)

on deduped_event e:
  seg = open_segments[e.window_id]            # per-window
  if seg is None: open_segments[e.window_id] = new_segment(e); return
  if e.app != seg.app or e.url_host != seg.url_host          # hard
     or (e.t - seg.last_active) > IDLE
     or (seg.tokens > MIN and drift(e, seg.centroid) > DRIFT) # soft
     or seg.duration > MAX:                                   # cap
       emit(close(seg)); open_segments[e.window_id] = new_segment(e)
  else:
       coalesce(seg, e)                        # extend, dedup, update centroid

## Online loop in English (Stage 2)

When a new deduped capture event arrives:
  Look up the segment currently open for that event's window   (one per window)
  If there isn't one: open a new segment with this event and stop here.
  If any of these boundary conditions are true:
     — the event is from a different app or website than the segment   (hard boundary)
     — too much idle time has passed since the segment was last active
     — the segment has enough content, and this event's meaning has
       drifted too far from the segment's running average               (soft boundary)
     — the segment has simply been open too long                        (duration cap)
  then: close the current segment and send it downstream,
        and open a fresh segment starting with this event.
  Otherwise:
        fold the event into the current segment — extend it, drop
        duplicate content, and update its running average meaning.


## Segment start/end thresholds (tune empirically) (Stage 2)

Token = A word. ie. bottle.

IDLE = A window inactive for 90 seconds closes its segment.

DRIFT cosine < 0.6 — when a new event's similarity to the segment centroid drops below 0.6, that is treated as a topic change.

MIN = A segment must reach 5 seconds of activity or a minimum amount of text, else it is dropped or merged into a neighbour.

MAX = A segment running past 15–30 minutes or past a token budget is split into chunks, so it stays coherent and fits downstream limits.

App-switch = Quick alt-tabbing does not count as a real app change, so brief glances at another window don't shatter segments.


##  Episode schema (Stage 2 output)

An episode is defined as a closed contiguous segment stored as one record from the same window and subject; and stored as such:

Episode { id, start, end, active_duration,
          app, window_title, url_host,        # PII-stripped
          source_mix:[ax|ocr|audio], text,    # fused, deduped
          participants,                       # from calendar/contacts
          content_hash,                       # idempotency
          salience }                          # drives Stage 4 escalation

## The salience score (Stage 2)

This score is a 0–1 estimate of how much an episode mattered to you. Its computed cheaply as a weighted mix of dwell time (40%), how much you typed (30%), and the app's class weight (30%). It's what decides whether stage 4 spends LLM effort distilling that episode.

## Indexing (Stage 3)

Every episode closed in stage 2 is added to a hybrid index. This is the firehose tier: everything is kept and everything is searchable, cheaply and without an LLM.

Ranking fuses four signals:

Semantic: the episode's embedding vector, compared to the query by cosine similarity. Finds meaning, not just words.

Lexical: BM25 keyword matching, so exact terms like an error code or a ticket number still hit.

Recency: Newer episodes score higher, decaying with a half-life of about 7 days.

Salience: episodes that mattered more to you rank higher.

Put simply: when a query arrives, every episode is scored on meaning, keywords, freshness, and importance, and the best blend wins. 


## The Distilation process (Stage 4)

Stages 1–3 are a live stream. An event becomes a segment and lands in the index within moments, with no LLM anywhere. Stage 4 leaves that stream. It is a batch job that runs later, daily, or when the machine is idle. It reads back the episodes stage 3 already stored. Its job is to skim the best of the raw record into compact, durable knowledge. It embeds and clusters the day's episodes into topic groups (no LLM), summarizes the most salient clusters within a fixed LLM budget (Currentyl OPenAI or Anthropic), and extracts entities and relations from those summaries into the knowledge graph. Anything the budget can't reach stays untouched and still fully searchable in stage 3.

Put simply: stage 3 keeps everything; stage 4 decides what is worth spending an LLM on.

## Escalation ladder (Stage 4)

Each tier processes fewer episodes at a higher cost per episode. 

T0: Embed and index. All ~300/day, free, local. Always searchable.

T1: Tag most episodes. Name entity recognition. Topic classification; cheap. Label with no LLM.

T2: Summarize salient episodes and rollups; one LLM pass per topic cluster.

T3: Graph extract. ~30/day; entity/relation/temporal extraction into the Knowledge Graph. Runs only on T2 summaries, never raw episodes.

T4: On demand query-time extraction when the graph lacks needed structure; pay only when asked.

A priority queue by salience drains against a fixed daily LLM budget; the tail stays at T0.

## Rollup hierarchy (Stage 4)

During stage 4, the following three subsections describe how stage 4's outputs become long-term memory. The summaries get progressively compressed as they age (daily → weekly → monthly, like time-series downsampling). Extracted truths land in a knowledge graph that marks superseded facts instead of overwriting them. Query-time retrieval blends all the tiers (vector search, graph, rollups, recency/salience) into one answer.


Daily a cluster ~300 episodes by topic with cheap embedding via cosine correlation is created. Each cluster get as LLM pass per cluster to detail themes, decisions, open loops. ~5–15 calls. This feeds the knowledge graph.

The same process occurs for:

Weekly: synthesize 7 dailies → progress, recurring people/projects.

Monthly/quarterly: synthesize weeklies → trajectory, long arcs.

## The recall tool

When the user asks their configured AI to continuum, ie. Claude to recollect historic activity, the systems recall tool is called. Continuum with non LLM of its own will return a small JSON list of relevant snippets for Claude's information.

After all the stages thus far accumulate and manage the information injected by the user via continuum's system supervision, we are left with a time pyramid of information. 

 Recent = full resolution, 
 Old = progressively compressed.


## Incremental temporal knowledge graph (Stage 4)

When extraction writes a fact into the graph, it stamps it with "valid_at" using the time the event happened.

Contradiction handling is when a new fact supersedes an old one, the old edge is not deleted. It is stamped with invalid_at and kept. This is what lets the graph answer "what changed" and "what was true before".

Put simply: the graph never overwrites what it knew. Facts gain an end date instead of disappearing, so the history of your knowledge stays queryable.

## 4d · Retrieval fuses tiers

A query is never answered from one store. It runs against several at once and the results are merged:

Vector search (T0): Finds episodes whose meaning matches the query.

Graph traversal (T3): Answers structured, temporal and multi-hop questions by walking entities and relations.

Rollup summaries: Premanufacured answers for span questions like "this week".

Recency/salience boosting: This tilts the blend toward fresh, important material.

Lazy extraction (T4): If the graph lacks the structure a query needs, it is extracted on the spot; pay only when asked.

Put simply: the agent asks one question; Continuum quietly consults every tier and hands back the best fused evidence.



## Cross-cutting concerns (the stuff that bites in prod)

PII boundary lives in Stage 2: redaction happens at segment close, before anything is embedded or persisted. Password fields are never captured at all; regex and NER scrub emails, cards and SSNs from the rest.

Crash safety: the segment accumulators are written to a write ahead log, and "content_hash" makes reprocessing idempotent. A replay after a crash cannot emit the same episode twice.
Under pressure the lowest salience items are dropped first. Capture is never blocked.

Event time is prioristed over arrival time. A reordering window with a watermark fuses UIA, audio and OCR into one episode by when things actually happened, not when they arrived.

## Battery budget

The only real cost in the live path is the drift embedding, so it is optional, throttled and batched. Rule-based boundaries alone get about 80% of the quality.

## Regenerable and versioned

Rollups are derived data. The prompt and model are versioned, so any rollup can be re-run later with a better model.

## Idle-aware scheduling

Heavy distillation waits for charging and idle. A local model fallback keeps the cost near zero. h

### Failure modes and mitigations

Over-segmentation: Rapid alt-tabbing while debugging shatters one piece of work into a mess. It can be currentlly mitigated in 3 ways. App switch debounce ignores brief glances, tiny segments are merged into a neighbour instead of kept, and Tier B re-merges any over-split fragments later.

Run-on: A whole day inside one IDE would otherwise become a single giant segment. Mitigated by the max-size cap, which chunks it, and drift detection, which splits it when the subject changes.

Volatile-UI noise: Clocks, notifications and ads change constantly without meaning anything. Mitigated by normalization (volatile tokens like timestamps are stripped before hashing) and by masking known noisy regions of the screen out of capture entirely.



## Privacy tiers (B2B)

Stage 4's rollup is where the team-knowledge layer is produced, consented, with PII redacted summaries only.

Raw episodes never leave the device. What rolls up to the team graph is only what the employee approved, and only after redaction.

Put simply its employee first and privacy tiered. The company sees the distilled, consented layer; it never sees raw data.



## The actual files responsible

The code conducting the above lives under daemon/. For the record, the embedder, LLM, and graph are dependency based. The whole pipeline runs and tests offline with zero network, and real adapters swap in for live use. Essentially, we can swap out the AI brains where required.

Stage 1: 

Capture: daemon/stage1/win-capture/ (Rust: uia.rs, ocr.rs, capture.rs). Builds; a live run reads the focused window via UIA.

Stage 2:

Dedup and segment: daemon/stage2/segmenter.mjs. Tests pass.

Stage 3:

Embed and index: daemon/stage3/index.mjs. Tests pass.

Stage 4: 

Distill to graph: daemon/stage4/distill.mjs. Tests pass.

Retrieval, fusing the tiers: daemon/retrieval.mjs. Covered by the end-to-end tests.

Orchestrator: daemon/pipeline.mjs. Tests pass, end-to-end.

Store, persistence: daemon/store.mjs. Tests pass.

Adapters, real and mock: daemon/adapters.mjs, daemon/util.mjs. No tests.



## Runbook

Offline tests (no network, no permissions)

npm test

live, local-only (builds the Rust capture helper on first run)

cd daemon\stage1\win-capture
cargo build --release
.\target\release\continuum-capture.exe | node ..\..\pipeline.mjs

or just, from the repo root (auto-builds and wires the pipe for you):

continuum start

An earlier 9-second polling loop is superseded by `stage1/capture.swift`
(event-driven) → `pipeline.mjs`.

## Open questions / what to tune

- Segmentation thresholds (IDLE / DRIFT / MIN / MAX) — needs real-usage tuning.
- Salience model: hand-weighted → learned (correction loop).
- Local vs hosted for T2 summarization (cost vs quality).
- Graph store: validated end-to-end on Neo4j + (Anthropic | OpenAI) extraction; open
  models can't satisfy the strict extraction schemas. See `backend/graphiti/`.
- How aggressively to compress old detail (retention policy per tier).
