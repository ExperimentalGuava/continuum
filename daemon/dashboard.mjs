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
import { buildDeps, loadConfig, DATA_DIR, readRawConfig, writeRawConfig } from './config.mjs';
import { loadEpisodes, loadIndex, STORE_FILE, rewriteEpisodes } from './store.mjs';

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
    const p = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    return !!(c.mcpServers && c.mcpServers.continuum);
  } catch { return false; }
}

function state() {
  const eps = loadEpisodes();
  return {
    paused: fs.existsSync(PAUSE),
    tier: cfg().tier,
    hasLLM: !!llm,
    dataDir: DATA_DIR,
    exclude: cfg().capture.exclude || [],
    apps: [...new Set(eps.map((e) => e.app || 'Unknown'))].sort(),
    sources: [...new Set(eps.flatMap((e) => e.source_mix || []))].sort(),
    mcp: { claude: mcpInstalled() },
    stats: computeStats(eps),
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
  const app = params.get('app'); const source = params.get('source');
  let rows;
  if (q) {
    const hits = await (await freshIndex()).search(q, { k: 40 });
    rows = hits.map((h) => ({ ...card(h.ep), score: Number(h.score.toFixed(3)) }));
  } else {
    rows = loadEpisodes().slice().reverse().map(card);
  }
  if (app) rows = rows.filter((r) => r.app === app);
  if (source) rows = rows.filter((r) => r.sources.includes(source));
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
  indexedAt = -1; _insAt = -1;
  return { removed: before - remaining, remaining };
}

const HTML = `<!doctype html><html lang=en><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>Continuum</title>
<style>
:root{
  --bg:#fbfbfd;--fg:#1d1d1f;--sec:#86868b;--faint:#b0b0b6;--ic:#33333a;--line:#e6e6ea;--fill:#f0f0f3;--fill2:#eaeaee;--card:#fff;
  --accent:#0071e3;--green:#1a9c4e;--danger:#e0352b;--bar:#c9c9ce;--barTop:#1d1d1f;
  --shadow:0 1px 2px rgba(0,0,0,.04),0 12px 38px rgba(0,0,0,.07);--ease:cubic-bezier(.22,.61,.36,1);
}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){
  --bg:#0a0a0b;--fg:#f5f5f7;--sec:#98989f;--faint:#5a5a61;--ic:#e4e4ea;--line:#212126;--fill:#161618;--fill2:#1d1d21;--card:#161618;
  --accent:#0a84ff;--green:#30d158;--danger:#ff453a;--bar:#3a3a3d;--barTop:#f5f5f7;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 16px 48px rgba(0,0,0,.55);
}}
:root[data-theme=dark]{
  --bg:#0a0a0b;--fg:#f5f5f7;--sec:#98989f;--faint:#5a5a61;--ic:#e4e4ea;--line:#212126;--fill:#161618;--fill2:#1d1d21;--card:#161618;
  --accent:#0a84ff;--green:#30d158;--danger:#ff453a;--bar:#3a3a3d;--barTop:#f5f5f7;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 16px 48px rgba(0,0,0,.55);
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
.row{width:100%;text-align:left;background:none;border:none;cursor:pointer;font:inherit;display:flex;align-items:center;gap:14px;padding:17px 2px;border-top:1px solid var(--line);transition:padding .2s var(--ease)}
.rows .row:first-child{border-top:none}
.row:hover{padding-left:9px;padding-right:0}
.row .body{flex:1;min-width:0}
.row .mt{font-size:16px;letter-spacing:-.011em;line-height:1.4}
.row .mm{margin-top:4px;font-size:13px;color:var(--sec)}
.row .chev{width:18px;height:18px;color:var(--faint);flex:none;transition:transform .2s var(--ease)}
.row.open .chev{transform:rotate(90deg)}
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
<div class=sheet id=sheet>
  <button class=mi data-go=timeline><svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.7 stroke-linecap=round stroke-linejoin=round><circle cx=12 cy=12 r="9"/><path d="M12 7v5l3 2"/></svg>Timeline<span class=sub>all moments</span></button>
  <button class=mi data-go=privacy><svg viewBox="0 0 24 24" fill=none stroke=currentColor stroke-width=1.7 stroke-linecap=round stroke-linejoin=round><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>Privacy &amp; data</button>
  <div class=div></div>
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
var S={view:'home',state:null,ins:null,result:null,query:'',facet:{q:''},open:{}};
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
    '<div class=mm>'+esc(r.app)+' &middot; '+esc(clock(r.time))+'</div></div>'+
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
      '<div class=foot>'+ICON.lock+'Everything stays on this Mac.</div>';
  });
}
function runAsk(q){
  if(!q.trim())return;S.query=q;
  var a=document.getElementById('ask');if(a)a.value=q;
  var b=document.getElementById('body');if(b)b.innerHTML='<div class=seclabel>Answer</div><div class=muted>Searching your memory&hellip;</div>';
  send('/api/ask','POST',{query:q}).then(function(r){S.result=r;if(S.view==='home')renderHome();});
}
function renderResult(){
  var r=S.result,b=document.getElementById('body');if(!b)return;
  var html='';
  if(r.answer){html+='<div class=seclabel>Answer</div><div class=answer>'+esc(r.answer).replace(/\\[(\\d+)\\]/g,function(m,n){return '<sup class=cite data-cite="'+n+'">'+n+'</sup>';})+'</div>';}
  else if(r.hasLLM===false){html+='<div class=seclabel>Answer</div><div class=note>No model connected, so here are the moments that match. Add a model in <b>Privacy &amp; data</b> to get a written answer with citations.</div>';}
  html+='<div class=seclabel style="margin-top:32px">'+(r.answer?'Sources':'Matching moments')+'</div>';
  html+='<div class=rows>'+(r.sources.length?r.sources.map(function(s){return momentRow(s,'');}).join(''):'<div class=muted>No matching moments found.</div>')+'</div>';
  html+='<button class=back data-home=1>'+ICON.back+'Back to today</button>';
  b.innerHTML=html;
}

/* ---------- TIMELINE ---------- */
function renderTimeline(){
  main.innerHTML='<button class=back id=back>'+ICON.back+'Today</button>'+
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

/* ---------- PRIVACY & DATA ---------- */
function renderPrivacy(){
  var st=S.state;if(!st)return;
  var excl=st.exclude.length?'<div class=tags>'+st.exclude.map(function(a){return '<span class=taga>'+esc(a)+'<span class=x data-unexcl="'+esc(a)+'">'+ICON.x+'</span></span>';}).join('')+'</div>':'<p>No apps excluded — everything visible is captured.</p>';
  var opts=st.apps.filter(function(a){return st.exclude.indexOf(a)<0;}).map(function(a){return '<option value="'+esc(a)+'">'+esc(a)+'</option>';}).join('');
  main.innerHTML='<button class=back id=back>'+ICON.back+'Today</button>'+
    '<div class=vh>Privacy &amp; data</div><div class=vsub>Your memory, on your terms. Nothing leaves this Mac.</div>'+
    '<div class=block><div class=line><span class=k>Capture</span><div class="sw'+(st.paused?'':' on')+'" id=pausesw><span class=knob></span></div></div>'+
      '<p style="margin-top:12px;margin-bottom:0">'+(st.paused?'Paused — nothing is being recorded.':'Active — capturing what you see.')+'</p></div>'+
    '<div class=block><h3>Excluded apps</h3><p>Apps Continuum should never capture. Applies next time you start capture.</p>'+excl+
      '<div class=addrow><select id=exsel>'+(opts||'<option value="">(no apps yet)</option>')+'</select><button class="btn solid" id=exadd>Exclude</button></div></div>'+
    '<div class=block><h3>Connect to Claude</h3><p>Let Claude read your memory over MCP.</p><div class=line><span class=k>Claude Desktop</span><span class="v'+(st.mcp.claude?' ok':'')+'">'+(st.mcp.claude?'connected':'not connected')+'</span></div>'+
      (st.mcp.claude?'':'<p style="margin-top:13px;margin-bottom:0">Run <code>continuum mcp-install</code>, then restart Claude.</p>')+'</div>'+
    '<div class=block><h3>Your data</h3><p>Stored only on this machine. Delete anything, anytime — it&rsquo;s gone for good.</p>'+
      '<div class=btnrow><button class=btn data-clear=lasthour>Last hour</button><button class=btn data-clear=today>Today</button><button class="btn danger" data-clear=all>Everything</button></div>'+
      '<div class=line style="margin-top:16px"><span class=k>Location</span><span class=path>'+esc(st.dataDir)+'</span></div>'+
      '<div class=line><span class=k>Total captured</span><span class=v>'+st.stats.total+' moments</span></div></div>';
}

/* ---------- shell ---------- */
function render(){if(S.view==='home')renderHome();else if(S.view==='timeline')renderTimeline();else renderPrivacy();}
function go(v){S.view=v;closeMenu();render();}
function home(){S.view='home';S.result=null;S.query='';render();}

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
  var del=t.closest('[data-del]');if(del){e.stopPropagation();send('/api/episode','DELETE',{hash:del.dataset.del}).then(function(){loadState();if(S.view==='timeline')loadRows();else if(S.result)renderResult();else renderInsights();});return;}
  var cite=t.closest('[data-cite]');if(cite){var el=document.getElementById('src-'+cite.dataset.cite);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('hl');setTimeout(function(){el.classList.remove('hl');},1200);}return;}
  if(t.closest('[data-home]')){home();return;}
  if(t.closest('#back')){home();return;}
  var sw=t.closest('#pausesw');if(sw){send('/api/pause','POST',{paused:!S.state.paused}).then(function(){loadState(true);});return;}
  var ex=t.closest('#exadd');if(ex){var v=document.getElementById('exsel').value;if(v)send('/api/exclude','POST',{app:v}).then(function(){loadState(true);});return;}
  var ux=t.closest('[data-unexcl]');if(ux){send('/api/exclude','POST',{app:ux.dataset.unexcl,remove:true}).then(function(){loadState(true);});return;}
  var cl=t.closest('[data-clear]');if(cl){var sc=cl.dataset.clear,lbl=sc==='all'?'everything':sc==='today'?"today's memory":'the last hour';if(confirm('Delete '+lbl+'? This cannot be undone.'))send('/api/clear','POST',{scope:sc}).then(function(){loadState(true);});return;}
  var rowEl=t.closest('.row');if(rowEl&&rowEl.dataset.hash){S.open[rowEl.dataset.hash]=!S.open[rowEl.dataset.hash];if(S.view==='timeline')loadRows();else if(S.result)renderResult();else renderInsights();return;}
});
main.addEventListener('input',function(e){if(e.target.id==='q'){clearTimeout(S._t);S.facet.q=e.target.value;S._t=setTimeout(loadRows,200);}else if(e.target.id==='ask'){S.query=e.target.value;}});
main.addEventListener('keydown',function(e){if(e.target.id==='ask'&&e.key==='Enter')runAsk(e.target.value);});
document.addEventListener('keydown',function(e){
  var typing=/^(input|textarea|select)$/i.test((e.target.tagName||''));
  if(e.key==='/'&&!typing){e.preventDefault();if(S.view!=='home')home();var a=document.getElementById('ask');if(a)a.focus();}
  if(e.key==='Escape'){if(sheet.classList.contains('on'))closeMenu();else if(S.result||S.view!=='home')home();}
});

function loadState(re){return getJSON('/api/state').then(function(s){S.state=s;var sub=document.getElementById('mcpsub');if(sub){sub.textContent=s.mcp.claude?'connected':'MCP';sub.className=s.mcp.claude?'sub ok':'sub';}if(re)render();});}
loadState().then(render);
setInterval(function(){loadState(false);if(S.view==='timeline'&&!S.facet.q)loadRows();},10000);
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
    if (p === '/api/episode' && req.method === 'DELETE') return json(res, delEpisode((await body(req)).hash));
    if (p === '/api/clear' && req.method === 'POST') return json(res, clear((await body(req)).scope));
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

const PORT = process.env.CONTINUUM_PORT || 3939;
server.listen(PORT, () => console.error(`continuum dashboard → http://localhost:${PORT}`));
