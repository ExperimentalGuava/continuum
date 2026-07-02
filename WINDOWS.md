# Continuum on Windows — quick start

Goal: download, double-click, use. No command line for day-to-day running.

## One-time setup

Continuum currently needs three things installed (a future bundled installer will remove these):

- **Node.js** (LTS) — https://nodejs.org  · *required*
- **Rust** — https://rustup.rs  · *required once*, to build the capture engine
- **Python 3** — https://python.org  · *optional*, only for voice/mic

Then get the code:
- Download the repo (green **Code → Download ZIP** on GitHub) and unzip it, **or** `git clone` it.

## Run it

**Double-click `Continuum.bat`** in the project folder.

- First run builds the capture engine (~1–2 min) and installs voice deps — one time.
- It then opens **http://localhost:3939** and keeps running in that window.
- Close the window to stop Continuum.

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
