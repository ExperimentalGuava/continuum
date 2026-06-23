# Continuum

[![ci](https://github.com/nikhilkagita04/continuum/actions/workflows/ci.yml/badge.svg)](https://github.com/nikhilkagita04/continuum/actions/workflows/ci.yml)

**Context dies at the app boundary.**

You bounce between Claude, Slack, X, Gemini, your design tool — a dozen apps a day — and each one
starts blank. What you were just doing in one is invisible to the next, so *you* become the
courier: re-pasting, re-explaining, rebuilding your context over and over.

Continuum carries it across. It quietly remembers what you do in every app — on your machine,
private, yours — so the next tool already knows. Ask Claude *"what was I just doing in X?"* and it does.

Open source. Local-first. A primitive you build on.

<p align="center"><img src="docs/assets/demo.png" width="100%" alt="Ask Claude what you were doing in another app — and it answers from your captured context"></p>

<p align="center"><em>Ask Claude <strong>"what was I just doing in X?"</strong> — and it answers from your own captured activity.</em></p>

## Install — about 30 seconds

Needs **Node 18+**. Don't have it? Grab it at [nodejs.org](https://nodejs.org) or `brew install node`.

```bash
npm install -g continuum-core
continuum verify          # prove it works — no keys, no permissions, no setup
```

`verify` captures a sample work session and answers questions about it — the whole
capture → memory → recall loop in one command.

<sub>Prefer source? <code>git clone https://github.com/nikhilkagita04/continuum && cd continuum && npm link</code></sub>

## Use it

```bash
continuum start
continuum dashboard
```

`start` captures what's on screen, on-device — grant **Screen Recording** once when macOS
prompts. `dashboard` opens your searchable timeline at `localhost:3939`.

## Connect it to Claude Desktop (MCP)

This is the payoff — Claude answers questions about what you've actually done. **Two steps:**

```bash
continuum mcp-install
```

1. Run that — it adds Continuum to Claude Desktop for you (no file editing, your existing
   config is preserved and backed up).
2. **Fully quit and reopen** Claude Desktop (Cmd+Q), then ask it *"what was I working on this morning?"*

Keep `continuum start` running so there's something to recall. Using a different MCP client
(Cursor, your own agent)? Run `continuum mcp-config` to print the config and add it yourself.

## What it is

A **primitive, not an app.** Most context tools are either closed "brain" apps you hand
everything to, or screen recorders that dump raw frames and leave you to dig. Continuum is the
open layer you build on:

- **Sees what you see** — on-device OCR of the focused window, captured only when the screen
  changes (not continuous recording), so it's faithful without being a firehose.
- **Local-first** — everything lives in `~/.continuum`; credential managers are excluded and
  PII is redacted; nothing leaves your machine.
- **Composable** — query it from the CLI, the SDK, or MCP, so any agent can use your memory.

## Tiers

| | Free | Pro *(later)* | Enterprise *(later)* |
|---|---|---|---|
| Capture · recall · MCP | ✅ | ✅ | ✅ |
| Embeddings / LLM | local, $0 | OpenAI / Anthropic | hosted |
| Temporal knowledge graph | — | ✅ | ✅ team graph |

The graph tier needs a frontier model (local models can't do reliable entity extraction), so
it's the natural paid line. Everything below it is free and local.

## How it works

<p align="center"><img src="docs/assets/pipeline.svg" width="100%" alt="capture → segment → index → distill"></p>

Four stages turn ~29k raw daily events into ~30 LLM calls — and the LLM never touches the
capture path, which is what keeps it light. Deep dive:
[docs/architecture/ingestion-pipeline.md](docs/architecture/ingestion-pipeline.md).

## Build on it

The stages are importable modules — a useful tool is ~20 lines. See `examples/` for a standup
generator and the Claude Desktop MCP config.

## Develop

```bash
npm test
swiftc daemon/stage1/screen.swift -o daemon/stage1/screen
```

`npm test` runs the 36-test suite (no network); the second line builds the macOS screen-capture
helper. Contributions under [DCO](https://developercertificate.org/) (`git commit -s`). License: Apache-2.0.
