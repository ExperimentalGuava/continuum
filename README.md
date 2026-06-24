# Continuum

[![ci](https://github.com/nikhilkagita04/continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilkagita04/continuum/actions/workflows/ci.yml)

**Your whole desktop context — everything you've seen, read, typed, and heard — as a single MCP your agent can use to understand you and how you work.**

Every agent starts blank, so *you* become the courier — re-pasting and re-explaining across a dozen apps a day. Continuum remembers what happens across your apps, on-device and private, and serves it to any agent over **MCP**. Ask Claude *"what was I just doing in X?"* and it already knows.

<p align="center"><a href="https://youtu.be/WnltmAaom7E"><img src="docs/assets/demo.png" width="100%" alt="Ask Claude what you were doing in another app — and it answers from your captured context"></a></p>

<p align="center"><strong><a href="https://youtu.be/WnltmAaom7E">▶ Watch the demo</a></strong></p>

## Get started

Hand it to your coding agent — paste this into **Claude Code, Codex, or Cursor**:

> Set up Continuum so you can see my desktop context: install it (`npm i -g continuum-core`), start
> capture in the background (`continuum start &` — I'll grant Screen Recording when macOS prompts),
> then add the Continuum MCP server from `continuum mcp-config`. From then on, use its `recall`,
> `catch_up`, and `profile` tools on your own judgment to understand what I'm building, how I think,
> and my taste — not only when I explicitly ask about my activity.

Then just ask it *"what was I doing in X?"* — that's the whole setup.

Prefer by hand? (needs **Node 18+**)

```bash
npm i -g continuum-core
continuum verify       # prove it works in 30s — no keys, no setup
continuum start        # live capture (grant Screen Recording once)
continuum dashboard    # your timeline + search at localhost:3939
continuum mcp-install  # connect it to Claude Desktop, then restart Claude
```

## What you get

- **Sees and hears your screen** — on-device OCR of the focused window (deduped to content, not noise), plus optional meeting transcription (mic + system audio, speaker-tagged, transcribe-then-delete).
- **Learns how you work** — standing preferences like *"be concise"* or *"run the tests before the PR"* apply to every agent automatically; you stay in control (dashboard or `continuum preferences`).
- **Local-first** — everything lives in `~/.continuum`; PII is redacted and credential managers excluded; nothing leaves your machine.

Runs free and on-device; point it at **Ollama** or add an **OpenAI / Anthropic** key for higher-quality inference.

## How it works

<p align="center"><img src="docs/assets/pipeline.svg" width="100%" alt="capture → segment → index → distill"></p>

Capture → segment → index → distill. The first three run locally and free; only distill calls an LLM — batched to roughly **1000× fewer calls** than processing every frame, and never on the capture path. The stages are importable modules — a useful tool is ~20 lines (see [`examples/`](examples/)). Deep dive: [architecture](docs/architecture/ingestion-pipeline.md).

## Develop

From a clone of the repo:

```bash
npm test                                                   # full suite, no network
swiftc daemon/stage1/screen.swift -o daemon/stage1/screen  # build the capture helper
```

`continuum eval` reports capture-quality metrics over local fixtures. Contributions under [DCO](https://developercertificate.org/) (`git commit -s`). License: Apache-2.0.
