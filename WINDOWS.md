# Continuum on Windows — quick start

Goal: download, double-click, use. No command line for day-to-day running.

## Recommended: the installer (nothing else to install)

Download **`Continuum-Setup.exe`** and double-click it. It bundles everything — the app,
a Node runtime, and the capture engine — so you do **not** need Node, Rust, or Python.
On install it detects the AI you already have and configures Continuum to match, then
adds a Start-Menu and desktop shortcut with the Continuum icon.

- **Where to get it:** the [Releases page](https://github.com/nikhilkagita04/continuum/releases)
  (attached to each `v*` release), or build it yourself — see
  [`packaging/windows/README.md`](packaging/windows/README.md).
- First launch: Windows SmartScreen may warn because the installer isn't code-signed yet
  — choose *More info → Run anyway*. (Signing is on the roadmap.)
- *Optional:* install [Python 3](https://python.org) if you want the mic/voice feature;
  everything else works without it.

---

## Alternative: run from source (for developers)

Continuum needs three things installed for the from-source path:

- **Node.js** (LTS) — https://nodejs.org  · *required*
- **Rust** — https://rustup.rs  · *required once*, to build the capture engine
- **Python 3** — https://python.org  · *optional*, only for voice/mic

Then get the code:
- Download the repo (green **Code → Download ZIP** on GitHub) and unzip it, **or** `git clone` it.

## Run it

**Double-click `Continuum.bat`** in the project folder.

- First run builds the capture engine (~1–2 min), installs voice deps, and **detects the AI you already have** — Ollama, a local AI app (LM Studio / Jan / LocalAI), an OpenAI or Anthropic key, or Claude Desktop — and configures Continuum to match, one time.
- It then opens **Continuum in its own app window** (its own icon, no browser tabs or address bar).
- Keep the small black launcher window open; close it to stop Continuum.

> On a machine with Edge or Chrome (nearly all Windows PCs), Continuum runs as a standalone
> app window. If neither is found, it opens in your default browser instead — same dashboard.

That's it — everything else is in the dashboard.

## Using the dashboard

- **Capture** switch — turns work-app capture on/off (Outlook, Teams, Jira, Slack, ServiceNow, Salesforce, Office).
- **Mic** switch — turns on-device voice on/off. When on, just say *"remind me to…"* or *"draft an email to…"* — no wake word.
- **Listening** — live transcript of what the mic hears.
- **Captured today / Lately** — a live summary of what's being collected.
- **Reminders / Drafts** — what the assistant has for you; delete any you don't want.

## Feed it to your AI (Claude Desktop)

Once, from the project folder:
```
node bin\continuum.mjs mcp-install
```
Then fully quit and reopen Claude Desktop. It can now use your captured context (`recall`, `catch_up`, `profile`, `reminders`).

## Notes

- Everything is captured and stored **locally**. Only the optional LLM pass leaves the device, and by default only *your own* content (`capture.egress: authored`).
- The `Continuum.bat` launcher assumes Node/Rust/Python are installed; it guides you if any are missing. A bundled, zero-prerequisite installer (and code-signed MSIX for fleet deploy) is the next packaging step.
