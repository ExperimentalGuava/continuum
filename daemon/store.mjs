// Persistence — a simple append-only NDJSON episode log. Decouples the capture daemon
// from the query interfaces (CLI / MCP / dashboard): capture appends, readers rebuild
// the index. Local-first, debuggable, greppable.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { HybridIndex } from './stage3/index.mjs';

export const STORE_FILE = path.join(DATA_DIR, 'episodes.ndjson');
// One record per daemon run (activation session): { id, start, end?, host }. Episodes captured
// during a run carry that run's `session_id`, so the dashboard can group "what this run collected".
export const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.ndjson');
// Explicit reminders the user creates (by voice or manually): { id, text, dueMs?, created, done }.
// Distinct from commitments DERIVED from captured correspondence — those are extracted, not stored.
export const REMINDERS_FILE = path.join(DATA_DIR, 'reminders.ndjson');
// Email drafts the assistant composed (by voice): { id, to?, subject?, body, created }. Persisted to
// disk (not held in memory) so the dashboard can show them on demand without a RAM cost.
export const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.ndjson');
// The most recent voice action ({ t, ok, action, message }) — the dashboard polls this to show a
// confirmation toast even when the native OS toast was missed.
export const LAST_ACTION_FILE = path.join(DATA_DIR, 'last-action.json');

export function appendEpisode(ep) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(STORE_FILE, JSON.stringify(ep) + '\n');
}

export function loadEpisodes() {
  try { return fs.readFileSync(STORE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

// --- activation sessions: one record per daemon run (mirrors the episode append-log pattern) ---
export function appendSession(sess) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(SESSIONS_FILE, JSON.stringify(sess) + '\n');
}

export function loadSessions() {
  try { return fs.readFileSync(SESSIONS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

// Stamp a session's end time (idempotent: won't overwrite an already-set end). Returns the record.
export function endSession(id, end = Date.now()) {
  const all = loadSessions();
  const s = all.find((x) => x.id === id);
  if (s && s.end == null) {
    s.end = end;
    fs.writeFileSync(SESSIONS_FILE, all.map((x) => JSON.stringify(x)).join('\n') + (all.length ? '\n' : ''));
  }
  return s;
}

// Discard one activation session: drop its episodes AND remove its session row. Returns # episodes removed.
export function discardSession(id) {
  const removed = loadEpisodes().length - rewriteEpisodes((e) => e.session_id !== id);
  const kept = loadSessions().filter((s) => s.id !== id);
  fs.writeFileSync(SESSIONS_FILE, kept.map((s) => JSON.stringify(s)).join('\n') + (kept.length ? '\n' : ''));
  return removed;
}

// --- explicit reminders (voice/manual) ---
export function appendReminder(r) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(REMINDERS_FILE, JSON.stringify(r) + '\n');
}

export function loadReminders() {
  try { return fs.readFileSync(REMINDERS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

// Mark a reminder done (idempotent). Returns true if one matched.
export function completeReminder(id) {
  const all = loadReminders();
  const r = all.find((x) => x.id === id);
  if (!r || r.done) return false;
  r.done = true;
  fs.writeFileSync(REMINDERS_FILE, all.map((x) => JSON.stringify(x)).join('\n') + (all.length ? '\n' : ''));
  return true;
}

// --- live transcript ("what's being heard") — a small rolling buffer for the dashboard ---
export const HEARD_FILE = path.join(DATA_DIR, 'heard.ndjson');
export function loadHeard() {
  try { return fs.readFileSync(HEARD_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
export function appendHeard(text, now = Date.now()) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const keep = [...loadHeard(), { t: now, text: String(text || '').slice(0, 300) }].slice(-40);
    fs.writeFileSync(HEARD_FILE, keep.map((x) => JSON.stringify(x)).join('\n') + '\n');
  } catch { /* non-fatal */ }
}

// --- live screen-capture feed: the mirror of `heard` for Text Capture. Written on every
// capture event so the dashboard can show activity IMMEDIATELY, without waiting for a
// segment to close into an episode. Deduped against the last entry so a re-read of the
// same window doesn't spam the feed. ---
export const LIVE_CAPTURE_FILE = path.join(DATA_DIR, 'live-capture.ndjson');
export function loadLiveCapture() {
  try { return fs.readFileSync(LIVE_CAPTURE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}
export function appendLiveCapture(ev, now = Date.now()) {
  try {
    const app = (ev && ev.app) || 'Unknown';
    const text = String((ev && ev.text) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) return;
    const cur = loadLiveCapture();
    const last = cur[cur.length - 1];
    if (last && last.app === app && last.text === text) return;   // skip an identical re-read
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // authored = the user is typing/sending here (compose box, chat input) → owner = you.
    const keep = [...cur, { t: now, app, text, authored: !!(ev && ev.authored) }].slice(-40);
    fs.writeFileSync(LIVE_CAPTURE_FILE, keep.map((x) => JSON.stringify(x)).join('\n') + '\n');
  } catch { /* non-fatal */ }
}

// --- dismissed reminders (delete) — keys of items the user removed, so derived ones stay gone ---
export const DISMISSED_FILE = path.join(DATA_DIR, 'dismissed-reminders.json');
export function loadDismissed() { try { return JSON.parse(fs.readFileSync(DISMISSED_FILE, 'utf8')); } catch { return []; } }
export function dismissReminder(key) {
  if (!key) return;
  const d = loadDismissed();
  if (!d.includes(key)) { d.push(key); try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DISMISSED_FILE, JSON.stringify(d)); } catch { /* non-fatal */ } }
}

// --- last voice action (feedback surface) ---
export function writeLastAction(a) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LAST_ACTION_FILE, JSON.stringify(a)); } catch { /* non-fatal */ }
}
export function readLastAction() {
  try { return JSON.parse(fs.readFileSync(LAST_ACTION_FILE, 'utf8')); } catch { return null; }
}

// --- email drafts (voice) ---
export function appendDraft(d) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(DRAFTS_FILE, JSON.stringify(d) + '\n');
}

export function loadDrafts() {
  try { return fs.readFileSync(DRAFTS_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

// Remove a draft once used/dismissed. Returns # remaining.
export function deleteDraft(id) {
  const kept = loadDrafts().filter((d) => d.id !== id);
  fs.writeFileSync(DRAFTS_FILE, kept.map((d) => JSON.stringify(d)).join('\n') + (kept.length ? '\n' : ''));
  return kept.length;
}

export async function loadIndex(embed) {
  const idx = new HybridIndex({ embed });
  for (const ep of loadEpisodes()) await idx.add(ep);
  return idx;
}

// Rewrite the store keeping only episodes for which keepFn is true. Returns # remaining.
// Used by the dashboard's delete / clear controls (the trust center).
export function rewriteEpisodes(keepFn) {
  const kept = loadEpisodes().filter(keepFn);
  fs.writeFileSync(STORE_FILE, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  return kept.length;
}

// Retention discharge: drop episodes older than `days`, EXCEPT those isPinned (e.g. linked to an
// open task — kept regardless of age). days <= 0 disables (keep everything). Timestamp is ms epoch;
// episodes carry `end` (last active) with start/t fallbacks. Returns { remaining, pruned }.
export function pruneEpisodes({ days = 7, now = Date.now(), isPinned = () => false } = {}) {
  if (!days || days <= 0) return { remaining: loadEpisodes().length, pruned: 0 };
  const floor = now - days * 864e5;
  const stamp = (e) => e.end ?? e.start ?? e.t ?? 0;
  let pruned = 0;
  const remaining = rewriteEpisodes((e) => {
    const keep = stamp(e) >= floor || isPinned(e);
    if (!keep) pruned += 1;
    return keep;
  });
  return { remaining, pruned };
}
