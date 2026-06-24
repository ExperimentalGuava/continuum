// Continuum MCP server — exposes your captured context so any MCP client (Claude Desktop, Cursor,
// your own agent) can understand you and tailor its help. Thin stdio JSON-RPC wrapper over the
// transport-free core in mcp.mjs. Design: docs/architecture/mcp.md.
//
// stdout is the protocol channel — all logging goes to stderr.
//   { "mcpServers": { "continuum": { "command": "node", "args": ["<abs>/daemon/mcp-server.mjs"] } } }
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { buildDeps, loadConfig, DATA_DIR } from './config.mjs';
import { loadIndex, loadEpisodes, STORE_FILE } from './store.mjs';
import { recall, catchUp, profile, snapshot } from './mcp.mjs';
import { instructionsBlock } from './preferences.mjs';

const { embed, llm } = buildDeps();
const AUDIT = path.join(DATA_DIR, 'mcp-queries.log');

// Rebuild the index + reload episodes when the store changes, so the agent sees new captures live.
const mtime = () => { try { return fs.statSync(STORE_FILE).mtimeMs; } catch { return 0; } };
let index = null, episodes = [], at = -1;
async function ready() { const m = mtime(); if (!index || m !== at) { episodes = loadEpisodes(); index = await loadIndex(embed); at = m; } return { index, episodes }; }

// Per-call scope from config: which apps are off-limits, whether MCP is paused, and any time floor.
const scope = () => {
  const c = loadConfig();
  return { exclude: c.capture.exclude || [], paused: !!(c.mcp && c.mcp.paused), floor: c.mcp && c.mcp.sinceDays > 0 ? Date.now() - c.mcp.sinceDays * 864e5 : 0 };
};
const audit = (tool, detail, n) => { try { fs.appendFileSync(AUDIT, JSON.stringify({ t: Date.now(), tool, detail, results: n }) + '\n'); } catch { /* best-effort */ } };

const TOOLS = [
  {
    name: 'recall',
    description:
      "Find specific moments from the user's own recent activity across all their apps — code, writing, reading, decisions, conversations. Use it to recall a specific thing they reference, learn how they did something before, or find what was decided. " +
      "Reach for it proactively, on your own judgment, whenever grounding your answer in what the user has actually done would make it more accurate or specific — don't wait to be asked. Filter by time/app/source to narrow.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'what to look for, in natural language' }, since: { type: 'string', description: 'optional lower bound: today | week | month | 24h | 7d | ISO date' }, until: { type: 'string', description: 'optional upper bound (same formats)' }, apps: { type: 'array', items: { type: 'string' }, description: 'optional: only these apps' }, sources: { type: 'array', items: { type: 'string' }, description: 'optional: ocr | input | audio | file' }, k: { type: 'number', description: 'max results (default 5)' } }, required: ['query'] },
  },
  {
    name: 'catch_up',
    description:
      "Get the user's recent activity (newest first) with no query needed — a snapshot of what they're working on and thinking about right now. Call it to orient yourself before responding so your help aligns with their current focus and style. Use `window` to pick the range.",
    inputSchema: { type: 'object', properties: { window: { type: 'string', description: 'today (default) | 24h | 7d | week' }, limit: { type: 'number', description: 'how many (default 12)' } } },
  },
  {
    name: 'profile',
    description:
      "Understand WHO this user is so you can tailor your help to them — what they're building, recurring people/projects/tools, how they think and write, their taste. Call it before giving generic advice on open-ended, creative, or work-related tasks so your answer fits them. Pass `topic` to focus (e.g. their taste in a specific area).",
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: "optional focus, e.g. 'design taste' or a project name" } } },
  },
];

const INSTRUCTIONS_BASE =
  "Continuum is the user's own recent activity across all their apps — a live window into what they're building, how they think and write, their decisions, and their taste. " +
  "Use it not only to recall specific things, but to genuinely understand this user and tailor your help to their real context, project, and preferences — like a teammate who's been watching their work, not a stranger. " +
  "Use judgment: reach for it whenever aligning to this specific person would improve the answer; you needn't for trivial factual lookups. Everything returned is a real captured moment with a citation id — ground your claims in it and never fabricate.";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const text = (id, t) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }] } });

const fmtResults = (rows) => rows.length
  ? rows.map((r, i) => `${i + 1}. [${r.when}] ${r.app} · ${r.who} · ${r.type}\n   ${r.text}\n   (id: ${r.id})`).join('\n\n')
  : 'No matching activity captured (yet). The user may not have done this on-device, or capture is paused.';

function fmtProfile(p) {
  if (p.paused) return p.note;
  const L = [];
  if (p.brief) L.push(p.brief, '');
  else L.push(`(${p.kind} profile${p.note ? ' — ' + p.note : ''})`, '');
  if (p.apps.length) L.push(`Apps: ${p.apps.join(', ')}`);
  if (p.recurring.length) L.push(`Recurring people/projects/topics: ${p.recurring.join(', ')}`);
  if (p.types.length) L.push(`Works in: ${p.types.filter(Boolean).join(', ')}`);
  if (p.voice_samples.length) L.push('', 'In their own words:', ...p.voice_samples.map((v) => `  • ${v}`));
  if (p.sources.length) L.push('', 'Grounded in:', ...p.sources.map((r) => `  • [${r.when}] ${r.app}: ${r.text.slice(0, 80)} (id: ${r.id})`));
  return L.join('\n');
}

async function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize': {
      const { episodes: eps } = await ready();
      const { exclude } = scope();
      const snap = snapshot(eps, { exclude });
      const prefs = instructionsBlock();                       // approved standing preferences, applied by default
      const instructions = INSTRUCTIONS_BASE + (snap ? `\n\n${snap}` : '') + (prefs ? `\n\n${prefs}` : '');
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'continuum', version: '0.5.0' }, instructions } };
    }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const { index: idx, episodes: eps } = await ready();
      const { name, arguments: args = {} } = params || {};
      const sc = scope();
      if (sc.paused) { audit(name, 'paused', 0); return text(id, 'Continuum is paused by the user (Privacy → Capture). No activity is available right now.'); }
      const common = { exclude: sc.exclude, floor: sc.floor };
      if (name === 'recall') {
        const rows = await recall(idx, eps, { ...args, ...common });
        audit('recall', args.query, rows.length);
        return text(id, fmtResults(rows));
      }
      if (name === 'catch_up') {
        const rows = catchUp(eps, { ...args, ...common });
        audit('catch_up', args.window || 'today', rows.length);
        return text(id, fmtResults(rows));
      }
      if (name === 'profile') {
        const p = await profile(eps, { ...args, llm, ...common });
        audit('profile', args.topic || '(general)', p.sources ? p.sources.length : 0);
        return text(id, fmtProfile(p));
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } };
    }
    default:
      return id != null ? { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } } : null;
  }
}

const rl = createInterface({ input: process.stdin });
console.error('continuum mcp server ready (stdio) — recall · catch_up · profile');
for await (const line of rl) {
  const s = line.trim(); if (!s) continue;
  let req; try { req = JSON.parse(s); } catch { continue; }
  const res = await handle(req); if (res) send(res);
}
