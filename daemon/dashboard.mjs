// Continuum dashboard — a local, no-network web app over ~/.continuum.
//
// The home answers two questions for you: "what happened?" (insights, surfaced) and "what do
// I want to know?" (ask). Everything else — Timeline, Privacy, Connect — folds behind one
// quiet menu. Apple-calm: near-monochrome, plain-language insights, hairline rows, lots of air,
// follows the system light/dark. Zero runtime deps — Node http + hand-rolled vanilla JS.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDeps, loadConfig, DATA_DIR, readRawConfig, writeRawConfig, claudeConfigPath } from './config.mjs';
import { loadEpisodes, loadIndex, STORE_FILE, rewriteEpisodes, loadDrafts, deleteDraft, readLastAction, completeReminder, loadReminders, loadHeard, loadLiveCapture, dismissReminder } from './store.mjs';
import { daemonState, startDaemon, stopDaemon, sessions as listSessions, discardSession } from './daemon-control.mjs';
import { classifyKind } from './stage4/extract.mjs';
import { servicedApps } from './apps.mjs';
import { remindList } from './stage4/reminders.mjs';
import { extractStated, extractInferred, activePreferences, loadStore as prefStore, approve as prefApprove, dismiss as prefDismiss, removeApproved as prefRemove } from './preferences.mjs';

const { embed, llm } = buildDeps();
const PAUSE = path.join(DATA_DIR, 'paused');
const cfg = () => loadConfig();

const json = (res, obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

const mtime = () => { try { return fs.statSync(STORE_FILE).mtimeMs; } catch { return 0; } };
let index = null, indexedAt = -1;
async function freshIndex() { const m = mtime(); if (!index || m !== indexedAt) { index = await loadIndex(embed); indexedAt = m; } return index; }

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

const card = (e) => ({
  hash: e.content_hash,
  app: e.app || 'Unknown',
  time: e.end || e.start || 0,
  sources: e.source_mix || [],
  snippet: ((e.structured && e.structured.summary) || e.text || '').slice(0, 320),
  full: e.text || '',
  authored: (e.structured && e.structured.authored) || '',
  salience: e.salience == null ? 0 : e.salience,
  session: e.session_id || null,
  kind: classifyKind(e),
  who: ((e.source_mix || []).includes('input') || (e.structured && e.structured.authored)) ? 'you' : 'other',
});

function computeStats(eps) {
  const t0 = startOfToday();
  const today = eps.filter((e) => (e.end || e.start || 0) >= t0);
  const byAppMap = new Map();
  for (const e of today) {
    const k = e.app || 'Unknown';
    const cur = byAppMap.get(k) || { app: k, count: 0, ms: 0 };
    cur.count++; cur.ms += e.active_duration || 0;
    byAppMap.set(k, cur);
  }
  const byApp = [...byAppMap.values()].sort((a, b) => b.ms - a.ms || b.count - a.count).slice(0, 6);
  const times = eps.map((e) => e.end || e.start || 0).filter(Boolean);
  return { total: eps.length, today: today.length, byApp, last: times.length ? Math.max(...times) : 0 };
}

function mcpInstalled() {
  try {
    const c = JSON.parse(fs.readFileSync(claudeConfigPath(), 'utf8'));
    return !!(c.mcpServers && c.mcpServers.continuum);
  } catch { return false; }
}

// Recent agent queries from the MCP audit log — surfaced in Privacy so the human sees exactly what
// their agent asked of their memory.
function recentMcpQueries(n = 8) {
  try { return fs.readFileSync(path.join(DATA_DIR, 'mcp-queries.log'), 'utf8').trim().split('\n').filter(Boolean).slice(-n).reverse().map((l) => JSON.parse(l)); }
  catch { return []; }
}

// A live one-liner of what's being collected right now — top apps + recurring names from the most
// recent moments. Heuristic (no LLM, no egress) so it's cheap enough to refresh on every poll.
const CAP = /\b[A-Z][a-zA-Z0-9]{2,}\b/g;
const SUM_STOP = new Set('The This That From Subject Received Preview Inbox Sent Size None Flag Status Unflagged Message HTML Page Content Reply Forward Email Voice Outlook Teams Jira Slack Connected Microsoft Exchange'.split(' '));
function liveSummary(eps) {
  const recent = eps.slice(-25);
  if (!recent.length) return '';
  const appc = new Map(), entc = new Map();
  for (const e of recent) {
    const a = e.app || '?'; appc.set(a, (appc.get(a) || 0) + 1);
    for (const w of String(e.text || '').match(CAP) || []) if (!SUM_STOP.has(w)) entc.set(w, (entc.get(w) || 0) + 1);
  }
  const top = (m, n) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map((x) => x[0]);
  const apps = top(appc, 2), ents = top(entc, 3);
  return 'Lately: ' + apps.join(', ') + (ents.length ? ' · ' + ents.join(', ') : '');
}

// A compact "what was captured" summary for the landing page (and the same shape the AI sees).
function summaryData(eps) {
  const t0 = startOfToday();
  const today = eps.filter((e) => (e.end || e.start || 0) >= t0);
  const byKind = {};
  for (const e of today) { const k = classifyKind(e); if (k && k !== 'other') byKind[k] = (byKind[k] || 0) + 1; }
  return { today: today.length, total: eps.length, byKind, live: liveSummary(eps), reminders: loadReminders().filter((r) => !r.done).length, drafts: loadDrafts().length };
}

function state() {
  const eps = loadEpisodes();
  return {
    paused: fs.existsSync(PAUSE),
    tier: cfg().tier,
    hasLLM: !!llm,
    dataDir: DATA_DIR,
    exclude: cfg().capture.exclude || [],
    serviced: servicedApps(),                                  // the curated work apps, for the exclude picker
    apps: [...new Set(eps.map((e) => e.app || 'Unknown'))].sort(),
    sources: [...new Set(eps.flatMap((e) => e.source_mix || []))].sort(),
    mcp: { claude: mcpInstalled(), queries: recentMcpQueries() },
    daemon: daemonState(),
    audio: audioState(),
    lastAction: readLastAction(),
    stats: computeStats(eps),
    summary: summaryData(eps),
  };
}

// Light heuristic so "worth remembering" can tag moments without an LLM.
function tagOf(t) {
  const s = (t || '').toLowerCase();
  if (/\b(decid|agreed|chose|going with|settled on|we'll ship|let's ship)\b/.test(s)) return 'decision';
  if (/\b(draft|not sent|to-?do|follow up|need to|reply later|unsent|tomorrow|next step)\b/.test(s)) return 'open loop';
  return '';
}

// The daily digest — the home's "what happened?". Factual parts always; an LLM-written
// one-liner when a model is configured, else a plain factual summary. Cached by store mtime
// so the (potentially costly) LLM call doesn't run on every poll.
let _ins = null, _insAt = -1;
async function insights() {
  const m = mtime();
  if (_ins && m === _insAt) return _ins;
  const eps = loadEpisodes();
  const t0 = startOfToday();
  const today = eps.filter((e) => (e.end || e.start || 0) >= t0);
  const stats = computeStats(eps);
  const activeMs = today.reduce((s, e) => s + (e.active_duration || 0), 0);
  const remember = today.slice()
    .sort((a, b) => (b.salience || 0) - (a.salience || 0))
    .filter((e) => (e.structured && e.structured.summary) || e.text)
    .slice(0, 3)
    .map((e) => {
      const t = (e.structured && e.structured.summary) || e.text || '';
      return { hash: e.content_hash, app: e.app || 'Unknown', time: e.end || e.start || 0, text: t.slice(0, 180), full: e.text || '', tag: tagOf(t) };
    });
  let summary = null;
  if (today.length) {
    if (llm) {
      const ctx = today.slice(-40).map((e) => '- ' + ((e.structured && e.structured.summary) || e.text || '').slice(0, 160)).join('\n');
      try {
        summary = await llm('In one or two short, natural sentences, recap what the user worked on today from these captured moments — like a friend summarizing their day. Be specific. No preamble, no lists.', ctx, 120);
      } catch { summary = null; }
    }
    if (!summary) {
      const top = stats.byApp.slice(0, 3).map((a) => a.app);
      summary = top.length ? ('Mostly in ' + top.slice(0, 2).join(' and ') + (top.length > 2 ? ', with some ' + top[2] : '') + '.') : null;
    }
  }
  _ins = { activeMs, byApp: stats.byApp, remember, summary, today: today.length, hasLLM: !!llm };
  _insAt = m;
  return _ins;
}

async function timeline(params) {
  const q = (params.get('q') || '').trim();
  const app = params.get('app'); const source = params.get('source'); const session = params.get('session');
  let rows;
  if (q) {
    const hits = await (await freshIndex()).search(q, { k: 40 });
    rows = hits.map((h) => ({ ...card(h.ep), score: Number(h.score.toFixed(3)) }));
  } else {
    rows = loadEpisodes().slice().reverse().map(card);
  }
  if (app) rows = rows.filter((r) => r.app === app);
  if (source) rows = rows.filter((r) => r.sources.includes(source));
  if (session) rows = rows.filter((r) => (session === '_legacy' ? !r.session : r.session === session));
  return rows.slice(0, 200);
}

async function ask(query) {
  if (!query.trim()) return { answer: null, sources: [], hasLLM: !!llm };
  const hits = await (await freshIndex()).search(query, { k: 6 });
  const sources = hits.map((h, i) => ({ ...card(h.ep), n: i + 1, score: Number(h.score.toFixed(3)) }));
  let answer = null;
  if (llm && sources.length) {
    const ctx = sources.map((s) => `[${s.n}] (${s.app}) ${s.full}`).join('\n');
    answer = await llm(
      'Answer the question using ONLY the numbered context from the user\'s own activity. Cite the moments you use inline as [n]. Be concise. If the answer is not in the context, say you do not have that in your memory yet.',
      `Context:\n${ctx}\n\nQuestion: ${query}`,
      320,
    );
  }
  return { answer, hasLLM: !!llm, sources };
}

function setExclude(app, remove) {
  if (!app) return { exclude: cfg().capture.exclude || [] };
  const raw = readRawConfig();
  raw.capture = raw.capture || {};
  const set = new Set(raw.capture.exclude || cfg().capture.exclude || []);
  if (remove) set.delete(app); else set.add(app);
  raw.capture.exclude = [...set];
  writeRawConfig(raw);
  return { exclude: raw.capture.exclude };
}

function setPause(on) {
  if (on) fs.writeFileSync(PAUSE, String(Date.now()));
  else { try { fs.unlinkSync(PAUSE); } catch { /* already off */ } }
  return { paused: fs.existsSync(PAUSE) };
}

// Call transcription (opt-in, off by default). enabled = master config; off = instant kill sentinel
// the daemon polls; recording = actually capturing right now. Three independent off-switches.
const AUDIO_OFF = path.join(DATA_DIR, 'audio-off');
function audioState() {
  const enabled = !!cfg().capture.audio;
  const off = fs.existsSync(AUDIO_OFF);
  return { enabled, off, recording: enabled && !off && daemonState().running };
}
function setAudio(on) {
  const raw = readRawConfig();
  raw.capture = raw.capture || {};
  raw.capture.audio = !!on;
  writeRawConfig(raw);
  if (on) { try { fs.unlinkSync(AUDIO_OFF); } catch { /* already on */ } }
  else fs.writeFileSync(AUDIO_OFF, String(Date.now()));   // instant kill — daemon stops the helper within ~2s
  return audioState();
}

function delEpisode(hash) {
  if (!hash) return { ok: false };
  const before = loadEpisodes().length;
  const remaining = rewriteEpisodes((e) => e.content_hash !== hash);
  indexedAt = -1; _insAt = -1;
  return { ok: true, removed: before - remaining, remaining };
}

function clear(scope) {
  let keep;
  if (scope === 'all') keep = () => false;
  else { const t0 = scope === 'lasthour' ? Date.now() - 3600e3 : startOfToday(); keep = (e) => (e.end || e.start || 0) < t0; }
  const before = loadEpisodes().length;
  const remaining = rewriteEpisodes(keep);
  indexedAt = -1; _insAt = -1; _candsAt = -1;
  return { removed: before - remaining, remaining };
}

// Discard one activation session: drop its episodes + the session row, then invalidate caches.
function discard(id) {
  if (!id) return { ok: false };
  const removed = discardSession(id);
  indexedAt = -1; _insAt = -1; _candsAt = -1;
  return { ok: true, removed };
}

// ---- preferences: how the user wants their agents to work (learn → curate → auto-apply) ----
// The raw extraction (stated + an optional model pass) is the costly part, so cache it by store
// mtime; the cheap approved/dismissed filtering runs fresh each call against the curated store.
let _cands = null, _candsAt = -1;
async function extractedPrefs() {
  const m = mtime();
  if (_cands && m === _candsAt) return _cands;
  const eps = loadEpisodes();
  _cands = [...extractStated(eps), ...(await extractInferred(eps, llm))];
  _candsAt = m;
  return _cands;
}
async function prefs() {
  const store = prefStore();
  const active = activePreferences(loadEpisodes(), store);     // approved + auto-applied, minus turned-off
  const have = new Set([...active.map((p) => p.id), ...store.dismissed]);
  const seen = new Set(); const suggested = [];
  for (const c of await extractedPrefs()) { if (have.has(c.id) || seen.has(c.id)) continue; seen.add(c.id); suggested.push(c); }
  suggested.sort((a, b) => b.confidence - a.confidence);
  return { active, suggested: suggested.slice(0, 12), hasLLM: !!llm };
}

const HTML = `<!doctype html><html lang=en><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>Continuum</title>
<style>
:root{
  --bg:#fbfbfd;--fg:#1d1d1f;--sec:#86868b;--faint:#b0b0b6;--ic:#33333a;--line:#e6e6ea;--fill:#f0f0f3;--fill2:#eaeaee;--card:#fff;
  --accent:#1a9c4e;--green:#1a9c4e;--danger:#e0352b;--bar:#c9c9ce;--barTop:#1d1d1f;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 12px 38px rgba(0,0,0,.07);--ease:cubic-bezier(.22,.61,.36,1);color-scheme:light;
}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0a0a0b;--fg:#f5f5f7;--sec:#98989f;--faint:#5a5a61;--ic:#e4e4ea;--line:#212126;--fill:#161618;--fill2:#1d1d21;--card:#161618;
  --accent:#30d158;--green:#30d158;--danger:#ff453a;--bar:#3a3a3d;--barTop:#f5f5f7;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 16px 48px rgba(0,0,0,.55);color-scheme:dark;
}}
:root[data-theme=dark]{
  --bg:#0a0a0b;--fg:#f5f5f7;--sec:#98989f;--faint:#5a5a61;--ic:#e4e4ea;--line:#212126;--fill:#161618;--fill2:#1d1d21;--card:#161618;
  --accent:#30d158;--green:#30d158;--danger:#ff453a;--bar:#3a3a3d;--barTop:#f5f5f7;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 16px 48px rgba(0,0,0,.55);color-scheme:dark;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font:17px/1.5 -apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Segoe UI',Roboto,sans-serif;letter-spacing:-.01em;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
svg{display:block}
@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
.top{max-width:600px;margin:0 auto;padding:19px 24px 0;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:9px;font-size:16px;font-weight:600;letter-spacing:-.014em;background:none;border:none;color:var(--fg);cursor:pointer;font-family:inherit}
.brand .mark{width:21px;height:21px}
.tools{display:flex;align-items:center;gap:2px}
.ico{width:38px;height:38px;border-radius:50%;border:none;background:none;color:var(--ic);display:grid;place-items:center;cursor:pointer;transition:background .2s var(--ease),color .2s var(--ease)}
.ico:hover{background:var(--fill)}
.ico:active{transform:scale(.94)}
.ico svg{width:21px;height:21px}
main{max-width:600px;margin:0 auto;padding:0 24px 96px;animation:rise .5s var(--ease)}
.eyebrow{margin-top:50px;font-size:12px;font-weight:600;letter-spacing:.066em;color:var(--sec);text-transform:uppercase}
.hi{margin-top:7px;font-size:32px;font-weight:600;letter-spacing:-.022em;line-height:1.07}
.ask{margin-top:24px;display:flex;align-items:center;gap:13px;height:58px;padding:0 18px;border-radius:16px;background:var(--fill);border:1px solid transparent;cursor:text;transition:background .2s var(--ease),border-color .2s var(--ease),box-shadow .2s var(--ease)}
.ask:hover{background:var(--fill2)}
.ask:focus-within{background:var(--card);border-color:var(--line);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 15%,transparent)}
.ask svg{width:20px;height:20px;color:var(--faint);flex:none}
.ask input{flex:1;border:none;background:none;outline:none;font:inherit;font-size:17px;letter-spacing:-.011em;color:var(--fg)}
.ask input::placeholder{color:var(--faint)}
.hintk{font-size:12px;color:var(--faint);border:1px solid var(--line);border-radius:7px;padding:3px 8px;font-weight:560}
.seclabel{margin:46px 2px 16px;font-size:12px;font-weight:600;letter-spacing:.055em;color:var(--sec);text-transform:uppercase;display:flex;align-items:center;justify-content:space-between}
.summary{font-size:23px;line-height:1.46;font-weight:400;letter-spacing:-.017em}
.summary b{font-weight:600}
.summary .dim{color:var(--sec)}
.muted{color:var(--sec);font-size:16px}
.where{margin-top:28px;display:flex;flex-direction:column;gap:16px}
.brow{display:flex;align-items:center;gap:16px}
.brow .nm{width:100px;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brow .track{flex:1;height:6px;background:var(--fill2);border-radius:99px;overflow:hidden}
.brow .fill{display:block;height:100%;background:var(--bar);border-radius:99px;transition:width .5s var(--ease)}
.brow:first-child .fill{background:var(--barTop)}
.brow .v{width:48px;text-align:right;font-size:14px;color:var(--sec);font-variant-numeric:tabular-nums}
.rows{margin-top:2px}
.row{width:100%;text-align:left;background:none;border:none;cursor:pointer;font:inherit;color:var(--fg);display:flex;align-items:center;gap:14px;padding:17px 2px;border-top:1px solid var(--line);transition:padding .2s var(--ease)}
.rows .row:first-child{border-top:none}
.row:hover{padding-left:9px;padding-right:0}
.row .body{flex:1;min-width:0}
.row .mt{font-size:16px;letter-spacing:-.011em;line-height:1.4}
.row .mm{margin-top:4px;font-size:13px;color:var(--sec)}
.chev{width:18px;height:18px;color:var(--faint);flex:none;transition:transform .2s var(--ease)}
.row.open .chev{transform:rotate(90deg)}
.seclabel[data-sec]{cursor:pointer;user-select:none;-webkit-user-select:none}
.seclabel[data-sec].open .chev{transform:rotate(90deg)}
.tag{font-size:11px;font-weight:560;color:var(--sec);background:var(--fill);border-radius:6px;padding:3px 9px;white-space:nowrap;letter-spacing:0}
.full{font-size:14.5px;color:var(--sec);line-height:1.55;padding:2px 2px 18px;white-space:pre-wrap;word-break:break-word}
.full .auth{color:var(--fg);margin-bottom:9px}
.full .del{margin-top:13px;font:inherit;font-size:13px;font-weight:560;color:var(--danger);background:none;border:1px solid color-mix(in srgb,var(--danger) 32%,var(--line));border-radius:9px;padding:7px 13px;cursor:pointer;transition:background .15s var(--ease)}
.full .del:hover{background:color-mix(in srgb,var(--danger) 8%,transparent)}
.answer{font-size:20px;line-height:1.62;letter-spacing:-.014em}
.cite{cursor:pointer;color:var(--accent);font-weight:600;font-size:.62em;vertical-align:super;padding:0 1px;text-decoration:none}
.note{font-size:14.5px;color:var(--sec);background:var(--fill);border-radius:13px;padding:14px 16px;line-height:1.5}
.note code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--fill2);padding:1px 6px;border-radius:5px}
.hl{background:color-mix(in srgb,var(--accent) 11%,transparent);border-radius:10px}
.foot{margin-top:56px;display:flex;align-items:center;justify-content:center;gap:7px;font-size:13px;color:var(--faint)}
.foot svg{width:14px;height:14px}
.back{display:inline-flex;align-items:center;gap:5px;margin-top:42px;background:none;border:none;color:var(--accent);font:inherit;font-size:15px;cursor:pointer;padding:0;transition:opacity .15s var(--ease)}
.back:hover{opacity:.7}
.back svg{width:18px;height:18px}
.vh{margin-top:20px;font-size:30px;font-weight:600;letter-spacing:-.022em}
.vsub{margin-top:5px;color:var(--sec);font-size:15px}
.search{margin-top:22px;display:flex;align-items:center;gap:12px;height:50px;padding:0 16px;border-radius:13px;background:var(--fill);transition:background .2s var(--ease),box-shadow .2s var(--ease)}
.search:focus-within{background:var(--card);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 15%,transparent)}
.search svg{width:18px;height:18px;color:var(--faint)}
.search input{flex:1;border:none;background:none;outline:none;font:inherit;font-size:16px;color:var(--fg)}
.block{margin-top:30px}
.block h3{font-size:17px;font-weight:600;letter-spacing:-.014em;margin-bottom:4px}
.block p{font-size:14px;color:var(--sec);margin-bottom:15px;line-height:1.5}
.line{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 0;border-top:1px solid var(--line)}
.block .line:first-of-type{border-top:none}
.line .k{font-size:15px}
.line .v{font-size:14px;color:var(--sec);font-variant-numeric:tabular-nums}
.line .v.ok{color:var(--green);font-weight:560}
.path{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--sec);word-break:break-all;text-align:right}
.sw{width:46px;height:28px;border-radius:99px;background:var(--fill2);border:1px solid var(--line);position:relative;cursor:pointer;transition:background .22s var(--ease),border-color .22s var(--ease);flex:none}
.sw .knob{position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:left .22s var(--ease)}
.sw.on{background:var(--green);border-color:var(--green)}
.sw.on .knob{left:20px}
.tags{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 14px}
.taga{font-size:13px;padding:5px 9px 5px 12px;border-radius:99px;background:var(--fill);display:flex;align-items:center;gap:7px}
.taga .x{cursor:pointer;color:var(--faint);display:grid;place-items:center;transition:color .15s var(--ease)}
.taga .x:hover{color:var(--danger)}
.taga .x svg{width:12px;height:12px}
.addrow{display:flex;gap:8px;margin-top:6px}
.addrow select{flex:1;padding:10px 12px;font:inherit;background:var(--fill);color:var(--fg);border:1px solid var(--line);border-radius:11px}
.btn{font:inherit;font-size:14px;font-weight:560;padding:9px 16px;border-radius:11px;border:1px solid var(--line);background:var(--fill);color:var(--fg);cursor:pointer;transition:background .15s var(--ease),transform .1s var(--ease)}
.btn:hover{background:var(--fill2)}
.btn:active{transform:scale(.97)}
.btn.solid{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 32%,var(--line))}
.btnrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(16px);max-width:440px;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:13px;padding:13px 18px;font-size:14.5px;color:var(--fg);opacity:0;pointer-events:none;transition:opacity .25s var(--ease),transform .25s var(--ease);z-index:60}
.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--faint);display:inline-block;flex:none;margin-right:7px;vertical-align:middle}
.dot.on{background:var(--green)}
.dot.warn{background:#d98324}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.28);opacity:0;pointer-events:none;transition:opacity .22s var(--ease);z-index:40}
.scrim.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;top:16px;right:16px;width:250px;background:var(--card);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:8px;z-index:50;transform:translateY(-8px) scale(.97);opacity:0;pointer-events:none;transition:transform .22s var(--ease),opacity .22s var(--ease);transform-origin:top right}
.sheet.on{transform:none;opacity:1;pointer-events:auto}
.mi{width:100%;display:flex;align-items:center;gap:13px;padding:11px 12px;border-radius:11px;background:none;border:none;cursor:pointer;font:inherit;font-size:15px;color:var(--fg);transition:background .15s var(--ease)}
.mi:hover{background:var(--fill)}
.mi svg{width:18px;height:18px;color:var(--sec);flex:none}
.mi .sub{margin-left:auto;font-size:12px;color:var(--faint)}
.mi .sub.ok{color:var(--green)}
.sheet .div{height:1px;background:var(--line);margin:6px 8px}
.plist{margin-top:4px}
.pref{display:flex;align-items:center;gap:14px;padding:16px 0;border-top:1px solid var(--line)}
.plist .pref:first-child{border-top:none}
.pbody{flex:1;min-width:0}
.pt{font-size:16px;letter-spacing:-.011em;line-height:1.4}
.pm{margin-top:4px;font-size:13px;color:var(--sec);text-transform:capitalize}
.pbtns{display:flex;gap:7px;flex:none}
.pbtns .btn{padding:8px 13px}
.pedit{flex:1;min-width:0;font:inherit;font-size:16px;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:11px;padding:11px 13px;outline:none}
.pedit:focus{box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 15%,transparent)}
</style></head>
<body>
<div class=top>
  <button class=brand id=home>
    <svg class=mark viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.7 stroke-linecap=round><path d="M3 12c2.5-5 6-5 9 0s6.5 5 9 0"/><path d="M3 12c2.5 5 6 5 9 0s6.5-5 9 0" opacity=".45"/></svg>
    Continuum
  </button>
  <div class=tools>
    <button class=ico id=theme aria-label=Appearance></button>
    <button class=ico id=menu aria-label=Menu><svg viewBox="0 0 24 24" fill=currentColor><circle cx=4.5 cy=12 r="2.15"/><circle cx=12 cy=12 r="2.15"/><circle cx=19.5 cy=12 r="2.15"/></svg></button>
  </div>
</div>
<main id=main></main>
<div class=scrim id=scrim></div>
<div class=toast id=toast></div>
<div class=sheet id=sheet>
  <button class=mi data-go=privacy><svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.7 stroke-linecap=round stroke-linejoin=round><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>Privacy &amp; data</button>
  <button class=mi data-go=privacy id=mcprow><svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.7 stroke-linecap=round stroke-linejoin=round><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/><path d="M9 21h6"/></svg>Connect to Claude<span class=sub id=mcpsub>MCP</span></button>
</div>
<script>
var ICON={
  search:'<svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><circle cx=11 cy=11 r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  chev:'<svg class=chev viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><path d="m9 6 6 6-6 6"/></svg>',
  back:'<svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.9 stroke-linecap=round stroke-linejoin=round><path d="m15 6-6 6 6 6"/></svg>',
  lock:'<svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><rect x=4 y=11 width=16 height=10 rx="2.2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  x:'<svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=2.2 stroke-linecap=round stroke-linejoin=round><path d="M18 6 6 18M6 6l12 12"/></svg>',
  moon:'<svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sun:'<svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.8 stroke-linecap=round stroke-linejoin=round><circle cx=12 cy=12 r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M4.4 4.4l1.7 1.7M17.9 17.9l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.4 19.6l1.7-1.7M17.9 6.1l1.7-1.7"/></svg>'
};
var SRC={ocr:'screen',screen:'screen',input:'typed',ax:'app',file:'file',clipboard:'clip',audio:'audio'};
var root=document.documentElement,main=document.getElementById('main');
var S={view:'control',state:null,ins:null,result:null,query:'',facet:{q:''},open:{},prefs:null,editPref:null,sessions:null,sessionDetail:null,drafts:null,reminders:null,sec:{voice:true,text:true}};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function clock(ms){if(!ms)return'';return new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function dur(ms){var m=Math.round(ms/60000);if(m<1)return'<1m';if(m<60)return m+'m';var h=Math.floor(m/60);return h+'h '+(m%60)+'m';}
function dateStr(){return new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'});}
function greet(){var h=new Date().getHours();return h<12?'Good morning.':h<18?'Good afternoon.':'Good evening.';}
function getJSON(u){return fetch(u).then(function(r){return r.json();});}
function send(u,m,b){return fetch(u,{method:m,headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json();});}

function momentRow(r,tag){
  var o=S.open[r.hash];
  return '<button class="row'+(o?' open':'')+'" id="'+(r.n?'src-'+r.n:'')+'" data-hash="'+esc(r.hash)+'">'+
    '<div class=body><div class=mt>'+(r.n?'<b style="color:var(--sec);font-weight:600;margin-right:7px">'+r.n+'</b>':'')+esc(r.snippet||r.text)+'</div>'+
    '<div class=mm>'+(r.kind&&r.kind!=='other'?esc(r.kind)+' &middot; ':'')+esc(r.app)+(r.who?' &middot; '+esc(r.who):'')+' &middot; '+esc(clock(r.time))+'</div></div>'+
    (tag?'<span class=tag>'+esc(tag)+'</span>':'')+ICON.chev+'</button>'+
    (o?'<div class=full>'+(r.authored?'<div class=auth>&#9998; you typed: '+esc(r.authored)+'</div>':'')+esc(r.full||r.text||'')+
      '<div><button class=del data-del="'+esc(r.hash)+'">Delete this moment</button></div></div>':'');
}

/* ---------- HOME: insights + ask (and ask results) ---------- */
function renderHome(){
  main.innerHTML='<div class=eyebrow>'+esc(dateStr())+'</div>'+
    (S.result?'':'<h1 class=hi>'+greet()+'</h1>')+
    '<label class=ask><span>'+ICON.search+'</span><input id=ask placeholder="Ask your memory anything" value="'+esc(S.query)+'"><span class=hintk>/</span></label>'+
    '<div id=body></div>';
  var a=document.getElementById('ask');a.focus();a.setSelectionRange(a.value.length,a.value.length);
  if(S.result)renderResult();else renderInsights();
}
function renderInsights(){
  var b=document.getElementById('body');if(!b)return;
  b.innerHTML='<div class=seclabel>Today</div><div class=muted>Loading your day&hellip;</div>';
  getJSON('/api/insights').then(function(d){
    S.ins=d;var b=document.getElementById('body');if(!b||S.result)return;
    if(!d.today){b.innerHTML='<div class=seclabel>Today</div><div class=note>Nothing captured yet today. Run <code>continuum start</code> and your day will show up here.</div>';return;}
    var where=d.byApp.length?('<div class=where>'+d.byApp.slice(0,4).map(function(a){var w=Math.max(4,Math.round(a.ms/(d.byApp[0].ms||1)*100));return '<div class=brow><span class=nm>'+esc(a.app)+'</span><span class=track><span class=fill style="width:'+w+'%"></span></span><span class=v>'+dur(a.ms)+'</span></div>';}).join('')+'</div>'):'';
    var rem=d.remember.length?('<div class=seclabel>Worth remembering</div><div class=rows>'+d.remember.map(function(r){return momentRow(r,r.tag);}).join('')+'</div>'):'';
    b.innerHTML='<div class=seclabel>Today</div>'+
      (d.summary?'<div class=summary>'+esc(d.summary)+'</div>':'<div class=muted>You were active for '+dur(d.activeMs)+' today.</div>')+
      where+rem+
      '<div class=foot>'+ICON.lock+'Everything stays on this device.</div>';
  });
}
function runAsk(q){
  if(!q.trim())return;S.query=q;
  // The ask box also lives on the landing (control) view; move to the results view so
  // the answer + sources have somewhere to render.
  if(S.view!=='home'){S.view='home';S.result=null;render();}
  var a=document.getElementById('ask');if(a)a.value=q;
  var b=document.getElementById('body');if(b)b.innerHTML='<div class=seclabel>Answer</div><div class=muted>Searching your memory&hellip;</div>';
  send('/api/ask','POST',{query:q}).then(function(r){S.result=r;if(S.view==='home')renderHome();});
}
function renderResult(){
  var r=S.result,b=document.getElementById('body');if(!b)return;
  var html='';
  if(r.answer){html+='<div class=seclabel>Answer</div><div class=answer>'+esc(r.answer).replace(/\\[(\\d+)\\]/g,function(m,n){return '<sup class=cite data-cite="'+n+'">'+n+'</sup>';})+'</div>';}
  else if(r.hasLLM===false){html+='<div class=seclabel>Answer</div><div class=note>No model connected, so here are the moments that match. Run <code>continuum setup</code> to connect a local model or API key for a written answer with citations.</div>';}
  html+='<div class=seclabel style="margin-top:32px">'+(r.answer?'Sources':'Matching moments')+'</div>';
  html+='<div class=rows>'+(r.sources.length?r.sources.map(function(s){return momentRow(s,'');}).join(''):'<div class=muted>No matching moments found.</div>')+'</div>';
  html+='<button class=back data-home=1>'+ICON.back+'Back to today</button>';
  b.innerHTML=html;
}

/* ---------- HOME: the whole simple dashboard — two switches, a summary, reminders, drafts ---------- */
function controlSwitches(){
  var dm=(S.state&&S.state.daemon)||{running:false};
  var au=(S.state&&S.state.audio)||{};
  var capOn=dm.running, micOn=!!(au.enabled&&!au.off);
  var capDot=dm.stopping?'<span class="dot warn"></span>':capOn?'<span class="dot on"></span>':'';
  var micDot=micOn?'<span class="dot on"></span>':'';
  return '<div class=block>'+
    '<div class=line><span class=k>'+capDot+'Text Capture</span><div class="sw'+(capOn?' on':'')+'" id=capturesw><span class=knob></span></div></div>'+
    '<div class=line><span class=k>'+micDot+'Voice Capture</span><div class="sw'+(micOn?' on':'')+'" id=micsw><span class=knob></span></div></div>'+
    '<p style="margin-top:10px;margin-bottom:0">'+(capOn?('On. Capturing your work apps'+(micOn?', voice listening for commands.':'.')):'Off. Flip Text Capture on to start.')+'</p></div>';
}
function summaryBlock(){
  var s=S.state&&S.state.summary; if(!s)return '';
  var kinds=Object.keys(s.byKind||{}).sort(function(a,b){return s.byKind[b]-s.byKind[a];}).map(function(k){return s.byKind[k]+' '+esc(k)+(s.byKind[k]===1?'':'s');}).join('  ·  ');
  return '<div class=block><div class=line><span class=k>Captured today</span><span class=v>'+(s.today||0)+' moment'+(s.today===1?'':'s')+'</span></div>'+
    (kinds?'<p style="margin-top:10px;margin-bottom:0">'+kinds+'</p>':'')+
    (s.live?'<p style="margin-top:6px;margin-bottom:0;color:var(--sec)">'+esc(s.live)+'</p>':'')+'</div>';
}
function draftRowCompact(d){
  return '<div class=line><span class=k>✉️ '+esc(d.subject||'(no subject)')+(d.to?' &middot; <span style="color:var(--sec)">'+esc(d.to)+'</span>':'')+'</span>'+
    '<span class=v><button class="btn solid" data-copy="'+esc(d.id)+'">Copy</button> <button class=btn data-draftdel="'+esc(d.id)+'">Delete</button></span></div>';
}
function loadControlLists(){
  getJSON('/api/reminders').then(function(d){S.reminders=d;var el=document.getElementById('remblock');if(!el)return;el.innerHTML=d.length?d.map(reminderRow).join(''):'<p class=muted style="padding:4px 2px 12px">Nothing pressing. Say &ldquo;remind me to&hellip;&rdquo;.</p>';});
  getJSON('/api/drafts').then(function(d){S.drafts=d;var el=document.getElementById('draftblock');if(!el)return;el.innerHTML=d.length?d.map(draftRowCompact).join(''):'<p class=muted style="padding:4px 2px 12px">No drafts yet. Say &ldquo;draft an email to&hellip;&rdquo;.</p>';});
  getJSON('/api/live').then(function(d){var el=document.getElementById('capnow');if(!el)return;
    if(!d.length){el.innerHTML='<p class=muted style="padding:4px 2px 12px">Nothing captured yet. Open a work app (Outlook, Teams, Jira, Slack) and its text shows up here.</p>';return;}
    var last=d[d.length-1],live=(Date.now()-last.t)<20000;
    var head=live?'<div class=line><span class=k><span class="dot on"></span>Capturing '+esc(last.app)+(last.authored?' &middot; composing':'')+'</span><span class=v>now</span></div>':'';
    el.innerHTML=head+d.slice(-12).reverse().map(function(r){return '<div class=line><span class=k>'+(r.authored?'<span class=tag style="color:var(--green)">you sent</span> ':'')+esc(r.app)+' &middot; <span style="color:var(--sec)">'+esc(r.text.slice(0,90))+'</span></span><span class=v>'+esc(clock(r.t))+'</span></div>';}).join('');});
  getJSON('/api/heard').then(function(d){var el=document.getElementById('heardblock');if(!el)return;el.innerHTML=d.length?d.slice(-10).reverse().map(function(h){return '<div class=line><span class=k>'+esc(h.text)+'</span><span class=v>'+esc(clock(h.t))+'</span></div>';}).join(''):'<p class=muted style="padding:4px 2px 12px">Voice Capture off, or nothing heard yet.</p>';});
}
function renderControl(){
  main.innerHTML='<div class=eyebrow>'+esc(dateStr())+'</div><h1 class=hi>'+greet()+'</h1>'+
    '<label class=ask><span>'+ICON.search+'</span><input id=ask placeholder="Ask your memory anything" value="'+esc(S.query)+'"><span class=hintk>/</span></label>'+
    '<div id=cswitch style="margin-top:22px">'+controlSwitches()+'</div>'+
    '<div id=csum style="margin-top:14px">'+summaryBlock()+'</div>'+
    '<div class="seclabel'+(S.sec.voice?' open':'')+'" data-sec=voice style="margin-top:24px">Voice Capture'+ICON.chev+'</div>'+
    '<div class=secbody'+(S.sec.voice?'':' style="display:none"')+'><div class=block id=heardblock><div class=muted style="padding:10px 0">&hellip;</div></div></div>'+
    '<div class="seclabel'+(S.sec.text?' open':'')+'" data-sec=text style="margin-top:18px">Text Capture'+ICON.chev+'</div>'+
    '<div class=secbody'+(S.sec.text?'':' style="display:none"')+'><div class=block id=capnow><div class=muted style="padding:10px 0">&hellip;</div></div></div>'+
    '<div class=seclabel style="margin-top:18px">Reminders</div><div class=block id=remblock><div class=muted style="padding:14px 0">Loading&hellip;</div></div>'+
    '<div class=seclabel style="margin-top:18px">Drafts</div><div class=block id=draftblock><div class=muted style="padding:14px 0">Loading&hellip;</div></div>';
  loadControlLists();
}
function refreshControl(){ var sw=document.getElementById('cswitch'); if(sw)sw.innerHTML=controlSwitches(); var su=document.getElementById('csum'); if(su)su.innerHTML=summaryBlock(); loadControlLists(); }

/* ---------- TIMELINE ---------- */
function renderTimeline(){
  main.innerHTML='<button class=back id=back>'+ICON.back+'Home</button>'+
    '<div class=vh>Timeline</div><div class=vsub>'+(S.state?S.state.stats.total:'')+' moments, newest first.</div>'+
    '<div class=search>'+ICON.search+'<input id=q placeholder="Search your memory&hellip;" value="'+esc(S.facet.q)+'"></div>'+
    '<div class=rows id=rows style="margin-top:12px"><div class=muted style="padding:18px 0">Loading&hellip;</div></div>';
  var q=document.getElementById('q');q.focus();q.setSelectionRange(q.value.length,q.value.length);
  loadRows();
}
function loadRows(){
  var p=new URLSearchParams();if(S.facet.q)p.set('q',S.facet.q);
  getJSON('/api/timeline?'+p.toString()).then(function(rows){var el=document.getElementById('rows');if(!el)return;el.innerHTML=rows.length?rows.map(function(r){return momentRow(r,'');}).join(''):'<div class=note>Nothing here yet. Run <code>continuum start</code>.</div>';});
}

/* ---------- SESSIONS: data collected per capture run ---------- */
function fmtDay(ms){if(!ms)return'';return new Date(ms).toLocaleDateString([],{month:'short',day:'numeric'});}
function loadSessions(){return getJSON('/api/sessions').then(function(d){S.sessions=d;if(S.view==='sessions'&&!S.sessionDetail)renderSessions();});}
function sessionRow(s){
  var when=s.legacy?'Before sessions':(fmtDay(s.start)+' · '+clock(s.start));
  var dwell=s.start?dur((s.end||Date.now())-s.start):'';
  var meta=[s.episodes+' moment'+(s.episodes===1?'':'s'),dwell,(s.apps&&s.apps.length?s.apps.slice(0,3).join(', '):'')].filter(Boolean).join(' · ');
  return '<div class=row data-session="'+esc(s.id)+'">'+
    '<div class=body><div class=mt>'+(s.active?'<span class="dot on"></span>':'')+esc(when)+(s.active?' <span class=tag>Recording</span>':'')+'</div>'+
    '<div class=mm>'+esc(meta)+'</div></div>'+
    (s.legacy?'':'<span class=tag data-discard="'+esc(s.id)+'">Discard</span>')+ICON.chev+'</div>';
}
function renderSessions(){
  if(S.sessionDetail){renderSessionDetail();return;}
  main.innerHTML='<button class=back id=back>'+ICON.back+'Home</button>'+
    '<div class=vh>Sessions</div><div class=vsub>Each capture run. What Continuum collected while active.</div>'+
    '<div class=rows id=srows style="margin-top:14px"><div class=muted style="padding:18px 0">Loading&hellip;</div></div>';
  if(!S.sessions){loadSessions();return;}
  var el=document.getElementById('srows');if(!el)return;
  el.innerHTML=S.sessions.length?S.sessions.map(sessionRow).join(''):'<div class=note>No capture runs yet. Turn on <b>Text Capture</b> from the home screen.</div>';
}
function renderSessionDetail(){
  var id=S.sessionDetail,s=(S.sessions||[]).filter(function(x){return x.id===id;})[0];
  var when=s?(s.legacy?'Before sessions':(fmtDay(s.start)+' · '+clock(s.start))):'Session';
  main.innerHTML='<button class=back id=sback>'+ICON.back+'Sessions</button>'+
    '<div class=vh>'+esc(when)+'</div><div class=vsub>'+(s?s.episodes+' moments captured this run.':'')+'</div>'+
    '<div class=rows id=rows style="margin-top:14px"><div class=muted style="padding:18px 0">Loading&hellip;</div></div>';
  var prm=new URLSearchParams();prm.set('session',id);
  getJSON('/api/timeline?'+prm.toString()).then(function(rows){var el=document.getElementById('rows');if(!el)return;el.innerHTML=rows.length?rows.map(function(r){return momentRow(r,'');}).join(''):'<div class=note>No moments in this session (discarded or pruned).</div>';});
}

/* ---------- REMINDERS: what to stay on top of ---------- */
function loadRemindersView(){return getJSON('/api/reminders').then(function(d){S.reminders=d;if(S.view==='reminders')renderReminders();});}
function reminderRow(it){
  var icon={reminder:'🔔',commitment:'•',waiting:'⏳',ticket:'🎫'}[it.kind]||'•';
  var due=it.dueMs?' · due '+new Date(it.dueMs).toLocaleDateString():'';
  var over=it.status==='overdue'?' <span class=tag style="color:var(--danger)">overdue</span>':'';
  var wait=it.kind==='waiting'?' <span class=tag>awaiting</span>':'';
  var del='<button class=btn data-remdismiss="'+esc(it.dkey||it.text)+'">Delete</button>';
  return '<div class=line><span class=k>'+icon+' '+esc(it.text)+over+wait+'</span><span class=v>'+esc((it.source||'')+due)+' '+del+'</span></div>';
}
function renderReminders(){
  main.innerHTML='<button class=back id=back>'+ICON.back+'Home</button>'+
    '<div class=vh>Reminders</div><div class=vsub>What to stay on top of: your reminders, open commitments, and due tickets.</div>'+
    '<div class=block id=remlist><div class=muted style="padding:18px 0">Loading&hellip;</div></div>';
  if(!S.reminders){loadRemindersView();return;}
  var el=document.getElementById('remlist');if(!el)return;
  el.innerHTML=S.reminders.length?S.reminders.map(reminderRow).join(''):'<div class=note>Nothing pressing. Say &ldquo;Continuum, remind me to&hellip;&rdquo; or it&rsquo;ll surface commitments from your captures.</div>';
}

/* ---------- DRAFTS: emails composed by voice ---------- */
function loadDraftsView(){return getJSON('/api/drafts').then(function(d){S.drafts=d;if(S.view==='drafts')renderDrafts();});}
function draftCard(d){
  return '<div class=block><div class=line><span class=k>'+esc(d.subject||'(no subject)')+'</span><span class=v>'+esc(d.to||'')+'</span></div>'+
    '<div class=full style="white-space:pre-wrap;padding-top:8px">'+esc(d.body||'')+'</div>'+
    '<div class=btnrow><button class="btn solid" data-copy="'+esc(d.id)+'">Copy</button><button class="btn danger" data-draftdel="'+esc(d.id)+'">Delete</button></div></div>';
}
function renderDrafts(){
  main.innerHTML='<button class=back id=back>'+ICON.back+'Home</button>'+
    '<div class=vh>Drafts</div><div class=vsub>Emails drafted by voice. Review, copy, paste into Outlook.</div>'+
    '<div id=draftlist style="margin-top:18px"><div class=muted style="padding:18px 0">Loading&hellip;</div></div>';
  if(!S.drafts){loadDraftsView();return;}
  var el=document.getElementById('draftlist');if(!el)return;
  el.innerHTML=S.drafts.length?S.drafts.map(draftCard).join(''):'<div class=note>No drafts yet. Say &ldquo;Continuum, draft an email to&hellip;&rdquo; while capture is running.</div>';
}

/* ---------- PRIVACY & DATA ---------- */
function renderPrivacy(){
  var st=S.state;if(!st)return;
  var serviced=st.serviced||[];
  var exLabel=function(k){for(var i=0;i<serviced.length;i++)if(serviced[i].key===k)return serviced[i].label;return k;};
  var excl=st.exclude.length?'<div class=tags>'+st.exclude.map(function(a){return '<span class=taga>'+esc(exLabel(a))+'<span class=x data-unexcl="'+esc(a)+'">'+ICON.x+'</span></span>';}).join('')+'</div>':'<p>Nothing excluded. All the serviced apps below are captured.</p>';
  var opts=serviced.filter(function(c){return st.exclude.indexOf(c.key)<0;}).map(function(c){return '<option value="'+esc(c.key)+'">'+esc(c.label)+'</option>';}).join('');
  main.innerHTML='<button class=back id=back>'+ICON.back+'Home</button>'+
    '<div class=vh>Privacy &amp; data</div><div class=vsub>Your memory, on your terms. Nothing leaves this device. Turn capture on or off from the home screen.</div>'+
    '<div class=block><div class=line><span class=k>Pause capture</span><div class="sw'+(st.paused?'':' on')+'" id=pausesw><span class=knob></span></div></div>'+
      '<p style="margin-top:12px;margin-bottom:0">'+(st.paused?'Paused. Capture is held; the session stays open.':'Live. Capturing while Continuum is active. Pause holds capture without ending the session.')+'</p></div>'+
    '<div class=block><div class=line><span class=k>Call transcription'+((st.audio&&st.audio.recording)?' <span class=dot style="background:var(--danger)"></span>':'')+'</span><div class="sw'+((st.audio&&st.audio.enabled&&!st.audio.off)?' on':'')+'" id=audiosw><span class=knob></span></div></div>'+
      '<p style="margin-top:12px;margin-bottom:0">'+((st.audio&&st.audio.recording)?'Recording. Transcribing the call on device.':(st.audio&&st.audio.enabled&&!st.audio.off)?'On (idle). Will transcribe Teams calls on device when one is active.':'Off. Transcribes Teams calls on device (transcribe then delete); your track and the other party are separate, and the remote side never leaves this device. Toggling off is an instant kill switch.')+'</p></div>'+
    '<div class=block><h3>Serviced apps</h3><p>The work apps Continuum captures. Exclude any you never want captured; the rest are captured when in focus. Applies next time you start capture.</p>'+excl+
      '<div class=addrow><select id=exsel>'+(opts||'<option value="">(all excluded)</option>')+'</select><button class="btn solid" id=exadd>Exclude</button></div></div>'+
    '<div class=block><h3>Connect to Claude</h3><p>Let Claude read your memory over MCP.</p><div class=line><span class=k>Claude Desktop</span><span class="v'+(st.mcp.claude?' ok':'')+'">'+(st.mcp.claude?'connected':'not connected')+'</span></div>'+
      (st.mcp.claude?'':'<p style="margin-top:13px;margin-bottom:0">Run <code>continuum mcp-install</code>, then restart Claude.</p>')+'</div>'+
    '<div class=block><h3>What your agent asked</h3><p>Every query an agent made to your memory, all on this device.</p>'+
      ((st.mcp.queries&&st.mcp.queries.length)?'<div>'+st.mcp.queries.map(function(q){return '<div class=line><span class=k>'+esc(q.tool)+(q.detail?': '+esc(String(q.detail).slice(0,52)):'')+'</span><span class=v>'+esc(clock(q.t))+' &middot; '+(q.results||0)+'</span></div>';}).join('')+'</div>':'<p style="color:var(--faint);margin:0">No agent queries yet.</p>')+'</div>'+
    '<div class=block><h3>Your data</h3><p>Stored only on this machine. Delete anything, anytime. It&rsquo;s gone for good.</p>'+
      '<div class=btnrow><button class=btn data-clear=lasthour>Last hour</button><button class=btn data-clear=today>Today</button><button class="btn danger" data-clear=all>Everything</button></div>'+
      '<div class=line style="margin-top:16px"><span class=k>Location</span><span class=path>'+esc(st.dataDir)+'</span></div>'+
      '<div class=line><span class=k>Total captured</span><span class=v>'+st.stats.total+' moments</span></div></div>';
}

/* ---------- PREFERENCES: how your agents work for you ---------- */
function loadPrefs(){return getJSON('/api/preferences').then(function(d){S.prefs=d;if(S.view==='preferences')renderPrefs();});}
function prefEditor(p){
  return '<div class=pref><input class=pedit id=pedit value="'+esc(p.text)+'">'+
    '<div class=pbtns><button class="btn solid" data-pref-save="'+esc(p.id)+'" data-kind="'+esc(p.kind)+'">Save</button><button class=btn data-pref-canceledit=1>Cancel</button></div></div>';
}
function prefActive(p){
  if(S.editPref===p.id)return prefEditor(p);
  var tag=p.applied==='auto'?'Auto-applied':'Approved';
  return '<div class=pref><div class=pbody><div class=pt>'+esc(p.text)+'</div><div class=pm>'+esc(p.kind)+' &middot; '+tag+'</div></div>'+
    '<div class=pbtns><button class=btn data-pref-edit="'+esc(p.id)+'">Edit</button><button class=btn data-pref-dismiss="'+esc(p.id)+'">Turn off</button></div></div>';
}
function prefSuggest(p){
  if(S.editPref===p.id)return prefEditor(p);
  return '<div class=pref><div class=pbody><div class=pt>'+esc(p.text)+'</div>'+
    '<div class=pm>'+esc(p.kind)+' &middot; '+Math.round(p.confidence*100)+'% &middot; '+esc(p.source)+'</div></div>'+
    '<div class=pbtns><button class="btn solid" data-pref-approve="'+esc(p.id)+'">Approve</button><button class=btn data-pref-edit="'+esc(p.id)+'">Edit</button><button class=btn data-pref-dismiss="'+esc(p.id)+'">Dismiss</button></div></div>';
}
function renderPrefs(){
  var head='<button class=back id=back>'+ICON.back+'Home</button>'+
    '<div class=vh>Preferences</div><div class=vsub>How your agents work for you. Learned from your activity &mdash; things you&rsquo;ve clearly stated apply automatically; everything else waits for your okay. Applied silently, never in the chat.</div>';
  var d=S.prefs;
  if(!d){main.innerHTML=head+'<div class=muted style="padding:22px 0">Loading&hellip;</div>';loadPrefs();return;}
  var active=d.active.length?('<div class=plist>'+d.active.map(prefActive).join('')+'</div>'):'<p>Nothing active yet. Approve a suggestion below &mdash; or just keep working, and preferences you state repeatedly turn on by themselves.</p>';
  var sugg=d.suggested.length?('<div class=plist>'+d.suggested.map(prefSuggest).join('')+'</div>'):'<p style="color:var(--faint);margin:0">Nothing new right now. Keep working &mdash; Continuum learns as you go.</p>';
  main.innerHTML=head+
    '<div class=block><h3>Active</h3><p>Applied by default in every agent session, over MCP. <b>Auto-applied</b> ones were learned from things you&rsquo;ve said more than once &mdash; turn any off anytime.</p>'+active+'</div>'+
    '<div class=block><h3>Suggested</h3><p>'+(d.hasLLM?'Learned from what you&rsquo;ve said and how you work. Approve to apply.':'Learned from what you&rsquo;ve said. Connect a model in Privacy &amp; data to also infer preferences from how you work.')+'</p>'+sugg+'</div>';
}

/* ---------- shell ---------- */
function render(){if(S.view==='control')renderControl();else if(S.view==='home')renderHome();else if(S.view==='timeline')renderTimeline();else if(S.view==='sessions')renderSessions();else if(S.view==='reminders')renderReminders();else if(S.view==='drafts')renderDrafts();else if(S.view==='preferences')renderPrefs();else renderPrivacy();}
function go(v){S.view=v;S.editPref=null;if(v==='preferences')S.prefs=null;if(v==='sessions'){S.sessions=null;S.sessionDetail=null;}if(v==='drafts')S.drafts=null;if(v==='reminders')S.reminders=null;closeMenu();render();}
function home(){S.view='control';S.result=null;S.query='';S.editPref=null;S.sessionDetail=null;render();}

/* theme: follow system unless overridden; persisted */
function effective(){var t=root.dataset.theme;if(t)return t;return matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';}
function paintTheme(){document.getElementById('theme').innerHTML=effective()==='dark'?ICON.sun:ICON.moon;}
try{var saved=localStorage.getItem('continuum-theme');if(saved)root.dataset.theme=saved;}catch(e){}
document.getElementById('theme').onclick=function(){var n=effective()==='dark'?'light':'dark';root.dataset.theme=n;try{localStorage.setItem('continuum-theme',n);}catch(e){}paintTheme();};
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',paintTheme);
paintTheme();

var sheet=document.getElementById('sheet'),scrim=document.getElementById('scrim');
function closeMenu(){sheet.classList.remove('on');scrim.classList.remove('on');}
document.getElementById('menu').onclick=function(e){e.stopPropagation();sheet.classList.toggle('on');scrim.classList.toggle('on');};
scrim.onclick=closeMenu;
document.getElementById('home').onclick=home;
sheet.addEventListener('click',function(e){var b=e.target.closest('[data-go]');if(b)go(b.dataset.go);});

main.addEventListener('click',function(e){
  var t=e.target;
  var sec=t.closest('[data-sec]');if(sec){var nm=sec.dataset.sec;S.sec[nm]=!S.sec[nm];sec.classList.toggle('open',S.sec[nm]);var body=sec.nextElementSibling;if(body)body.style.display=S.sec[nm]?'':'none';return;}
  var del=t.closest('[data-del]');if(del){e.stopPropagation();send('/api/episode','DELETE',{hash:del.dataset.del}).then(function(){loadState();if(S.view==='timeline')loadRows();else if(S.result)renderResult();else renderInsights();});return;}
  var cite=t.closest('[data-cite]');if(cite){var el=document.getElementById('src-'+cite.dataset.cite);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('hl');setTimeout(function(){el.classList.remove('hl');},1200);}return;}
  if(t.closest('[data-home]')){home();return;}
  if(t.closest('#sback')){S.sessionDetail=null;render();return;}
  if(t.closest('#back')){home();return;}
  var dsc=t.closest('[data-discard]');if(dsc){e.stopPropagation();if(confirm('Discard this session’s data? This deletes its captured moments and cannot be undone.'))send('/api/sessions/discard','POST',{id:dsc.dataset.discard}).then(function(){S.sessions=null;S.sessionDetail=null;loadSessions();});return;}
  var srow=t.closest('[data-session]');if(srow){S.sessionDetail=srow.dataset.session;renderSessionDetail();return;}
  var sw=t.closest('#pausesw');if(sw){send('/api/pause','POST',{paused:!S.state.paused}).then(function(){loadState(true);});return;}
  var asw=t.closest('#audiosw');if(asw){var on=S.state.audio&&S.state.audio.enabled&&!S.state.audio.off;send('/api/audio','POST',{enabled:!on}).then(function(){loadState(true);});return;}
  var cp=t.closest('[data-copy]');if(cp){var dr=(S.drafts||[]).filter(function(x){return x.id===cp.dataset.copy;})[0];if(dr&&navigator.clipboard){navigator.clipboard.writeText(dr.body||'');cp.textContent='Copied';setTimeout(function(){cp.textContent='Copy';},1200);}return;}
  var dd=t.closest('[data-draftdel]');if(dd){send('/api/drafts','DELETE',{id:dd.dataset.draftdel}).then(function(){S.drafts=null;loadDraftsView();});return;}
  var rmd=t.closest('[data-remdismiss]');if(rmd){send('/api/reminders/dismiss','POST',{key:rmd.dataset.remdismiss}).then(function(){S.reminders=null;if(S.view==='reminders')loadRemindersView();else loadControlLists();});return;}
  var csw=t.closest('#capturesw');if(csw){var con=S.state.daemon&&S.state.daemon.running;send(con?'/api/daemon/stop':'/api/daemon/start','POST',{}).then(function(){bumpPoll();loadState(true);});return;}
  var msw=t.closest('#micsw');if(msw){var mon=S.state.audio&&S.state.audio.enabled&&!S.state.audio.off;send('/api/audio','POST',{enabled:!mon}).then(function(){loadState(true);});return;}
  var ex=t.closest('#exadd');if(ex){var v=document.getElementById('exsel').value;if(v)send('/api/exclude','POST',{app:v}).then(function(){loadState(true);});return;}
  var ux=t.closest('[data-unexcl]');if(ux){send('/api/exclude','POST',{app:ux.dataset.unexcl,remove:true}).then(function(){loadState(true);});return;}
  var cl=t.closest('[data-clear]');if(cl){var sc=cl.dataset.clear,lbl=sc==='all'?'everything':sc==='today'?"today's memory":'the last hour';if(confirm('Delete '+lbl+'? This cannot be undone.'))send('/api/clear','POST',{scope:sc}).then(function(){loadState(true);});return;}
  var pa=t.closest('[data-pref-approve]');if(pa){var paf=(S.prefs.suggested||[]).filter(function(x){return x.id===pa.dataset.prefApprove;})[0];if(paf)send('/api/preferences/approve','POST',{text:paf.text,kind:paf.kind}).then(function(d){S.prefs=d;renderPrefs();});return;}
  var pe=t.closest('[data-pref-edit]');if(pe){S.editPref=pe.dataset.prefEdit;renderPrefs();var pi=document.getElementById('pedit');if(pi){pi.focus();pi.setSelectionRange(pi.value.length,pi.value.length);}return;}
  if(t.closest('[data-pref-canceledit]')){S.editPref=null;renderPrefs();return;}
  var psv=t.closest('[data-pref-save]');if(psv){var inp=document.getElementById('pedit'),nv=inp?inp.value.trim():'',orig=((S.prefs.suggested||[]).concat(S.prefs.active||[])).filter(function(x){return x.id===psv.dataset.prefSave;})[0];if(nv){var bd={text:nv,kind:psv.dataset.kind};if(orig&&nv!==orig.text)bd.from=psv.dataset.prefSave;send('/api/preferences/approve','POST',bd).then(function(d){S.editPref=null;S.prefs=d;renderPrefs();});}return;}
  var pds=t.closest('[data-pref-dismiss]');if(pds){send('/api/preferences/dismiss','POST',{id:pds.dataset.prefDismiss}).then(function(d){S.prefs=d;renderPrefs();});return;}
  var rowEl=t.closest('.row');if(rowEl&&rowEl.dataset.hash){S.open[rowEl.dataset.hash]=!S.open[rowEl.dataset.hash];if(S.view==='timeline')loadRows();else if(S.view==='sessions'&&S.sessionDetail)renderSessionDetail();else if(S.result)renderResult();else renderInsights();return;}
});
main.addEventListener('input',function(e){if(e.target.id==='q'){clearTimeout(S._t);S.facet.q=e.target.value;S._t=setTimeout(loadRows,200);}else if(e.target.id==='ask'){S.query=e.target.value;}});
main.addEventListener('keydown',function(e){if(e.target.id==='ask'&&e.key==='Enter')runAsk(e.target.value);else if(e.target.id==='pedit'&&e.key==='Enter'){var sb=document.querySelector('[data-pref-save]');if(sb)sb.click();}else if(e.target.id==='pedit'&&e.key==='Escape'){e.stopPropagation();S.editPref=null;renderPrefs();}});
document.addEventListener('keydown',function(e){
  var typing=/^(input|textarea|select)$/i.test((e.target.tagName||''));
  if(e.key==='/'&&!typing){e.preventDefault();var a=document.getElementById('ask');if(!a){S.view='home';render();a=document.getElementById('ask');}if(a)a.focus();}
  if(e.key==='Escape'){if(sheet.classList.contains('on'))closeMenu();else if(S.result||S.view!=='home')home();}
});

function showToast(msg){var el=document.getElementById('toast');if(!el)return;el.textContent='✓ '+msg;el.classList.add('on');clearTimeout(S._tt);S._tt=setTimeout(function(){el.classList.remove('on');},4500);}
function loadState(re){return getJSON('/api/state').then(function(s){S.state=s;var sub=document.getElementById('mcpsub');if(sub){sub.textContent=s.mcp.claude?'connected':'MCP';sub.className=s.mcp.claude?'sub ok':'sub';}var la=s.lastAction&&s.lastAction.t?s.lastAction.t:0;if(S._laSeen===undefined)S._laSeen=la;else if(la&&la!==S._laSeen){S._laSeen=la;if(s.lastAction.message)showToast(s.lastAction.message);}if(re)render();});}
/* after start/stop, poll a bit faster so the status indicator flips as daemon.json appears/clears */
function bumpPoll(){var n=0;var iv=setInterval(function(){loadState(false).then(function(){if(S.view==='privacy')render();else if(S.view==='control')refreshControl();});if(++n>=6)clearInterval(iv);},1500);}
loadState().then(render);
setInterval(function(){loadState(false).then(function(){if(S.view==='control')refreshControl();});if(S.view==='timeline'&&!S.facet.q)loadRows();else if(S.view==='sessions'&&!S.sessionDetail)loadSessions();},5000);
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (p === '/api/state') return json(res, state());
    if (p === '/api/insights') return json(res, await insights());
    if (p === '/api/timeline') return json(res, await timeline(u.searchParams));
    if (p === '/api/ask' && req.method === 'POST') return json(res, await ask((await body(req)).query || ''));
    if (p === '/api/exclude' && req.method === 'POST') { const b = await body(req); return json(res, setExclude(b.app, b.remove)); }
    if (p === '/api/pause' && req.method === 'POST') return json(res, setPause(!!(await body(req)).paused));
    if (p === '/api/audio' && req.method === 'POST') return json(res, setAudio(!!(await body(req)).enabled));
    if (p === '/api/audio') return json(res, audioState());
    if (p === '/api/daemon') return json(res, daemonState());
    if (p === '/api/daemon/start' && req.method === 'POST') return json(res, startDaemon());
    if (p === '/api/daemon/stop' && req.method === 'POST') return json(res, stopDaemon());
    if (p === '/api/sessions') return json(res, listSessions());
    if (p === '/api/sessions/discard' && req.method === 'POST') return json(res, discard((await body(req)).id));
    if (p === '/api/drafts' && req.method === 'DELETE') return json(res, { remaining: deleteDraft((await body(req)).id) });
    if (p === '/api/drafts') return json(res, loadDrafts().slice().reverse());
    if (p === '/api/reminders/done' && req.method === 'POST') return json(res, { ok: completeReminder((await body(req)).id) });
    if (p === '/api/reminders/dismiss' && req.method === 'POST') { dismissReminder((await body(req)).key); return json(res, { ok: true }); }
    if (p === '/api/heard') return json(res, loadHeard());
    if (p === '/api/live') return json(res, loadLiveCapture());
    // heuristic only (no LLM on a background poll → fast, no egress, RAM-light)
    if (p === '/api/reminders') return json(res, await remindList(loadEpisodes(), {}));
    if (p === '/api/episode' && req.method === 'DELETE') return json(res, delEpisode((await body(req)).hash));
    if (p === '/api/clear' && req.method === 'POST') return json(res, clear((await body(req)).scope));
    if (p === '/api/preferences') return json(res, await prefs());
    if (p === '/api/preferences/approve' && req.method === 'POST') { const b = await body(req); prefApprove(b); if (b.from) prefDismiss(b.from); return json(res, await prefs()); }
    if (p === '/api/preferences/dismiss' && req.method === 'POST') { prefDismiss((await body(req)).id); return json(res, await prefs()); }
    if (p === '/api/preferences/remove' && req.method === 'POST') { prefRemove((await body(req)).id); return json(res, await prefs()); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

const PORT = process.env.CONTINUUM_PORT || process.env.PORT || 3939;
// If the port is already taken, Continuum is already running — exit calmly instead of
// letting an unhandled 'error' event crash the process (which, when a launcher relaunches
// it, shows up as console windows flashing open and shut).
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') { console.error(`continuum dashboard already running at http://localhost:${PORT}`); process.exit(0); }
  console.error(`continuum dashboard error: ${(e && e.message) || e}`); process.exit(1);
});
server.listen(PORT, () => console.error(`continuum dashboard → http://localhost:${PORT}`));
