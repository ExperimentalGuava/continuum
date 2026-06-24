// Continuum MCP server — exposes your captured context as MCP tools so any MCP client
// (Claude Desktop, Cursor, your own agent) can query your memory. This is the shovel's
// primary integration surface: build use cases on top without touching the internals.
//
// Implements the MCP stdio transport (newline-delimited JSON-RPC 2.0). stdout is the
// protocol channel — all logging goes to stderr.
//
// Claude Desktop config (claude_desktop_config.json):
//   { "mcpServers": { "continuum": { "command": "node", "args": ["<abs>/daemon/mcp-server.mjs"] } } }
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { buildDeps } from './config.mjs';
import { loadIndex, STORE_FILE } from './store.mjs';

const { embed } = buildDeps();
// Rebuild the index when the store changes, so Claude sees new captures without a restart.
const mtime = () => { try { return fs.statSync(STORE_FILE).mtimeMs; } catch { return 0; } };
let index = null, indexedAt = -1;
const ready = async () => { const m = mtime(); if (!index || m !== indexedAt) { index = await loadIndex(embed); indexedAt = m; } return index; };

const TOOLS = [
  {
    name: 'search_context',
    description:
      "Search the user's own recent on-device activity across all their apps — their projects, code, writing, reading, decisions, and conversations. " +
      "Use it two ways: (1) to recall a specific thing they reference, and — the bigger one — (2) to understand WHO this user is so you can tailor your help to them: what they're building, how they think and write, their stack and prior choices, their taste and preferences. " +
      "Reach for it proactively to make your answer fit THIS user's real context, project, and style — even on open-ended or generic-looking tasks where they never mentioned their activity. The better you understand them, the more useful your answer; prefer learning from their context over giving generic advice. " +
      "Returns the most relevant captured moments, each tagged with the app it came from.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'what to look for, in natural language (a topic, a project, how they did something before, what they care about)' }, k: { type: 'number', description: 'max results (default 5)' } }, required: ['query'] },
  },
  {
    name: 'recent_activity',
    description:
      "Get the user's most recent activity across their apps (newest first) — a live snapshot of what they're building and thinking about right now. " +
      "Call it to orient yourself in their world before responding, so your help aligns with their current project, focus, and style — not just for \"what was I doing\" questions, but any time understanding their situation would make your answer more useful and more tailored to them.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'how many (default 10)' } } },
  },
];

// Server-level guidance (surfaced to the client/agent): treat this as getting to know the user.
const INSTRUCTIONS =
  "Continuum is the user's own recent activity across all their apps — a live window into what they're building, how they think and write, the decisions they've made, and their taste. " +
  "Use it not only to recall specific things, but to genuinely understand this user and tailor your help to their real context, project, and preferences. Before giving generic advice on anything open-ended, creative, or related to their work, consult Continuum so your answer fits who they are and what they're trying to do — like a teammate who's been watching their work, not a stranger. " +
  "Use judgment: reach for it whenever aligning to this specific person would improve the answer; you don't need it for trivial factual lookups.";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const text = (id, t) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }] } });

async function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'continuum', version: '0.4.0' }, instructions: INSTRUCTIONS } };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'tools/call': {
      const idx = await ready();
      const { name, arguments: args = {} } = params || {};
      if (name === 'search_context') {
        const hits = await idx.search(args.query, { k: args.k || 5 });
        return text(id, hits.length ? hits.map((h, i) => `${i + 1}. [${h.ep.app}] ${h.ep.text}`).join('\n') : 'No matching context captured yet.');
      }
      if (name === 'recent_activity') {
        const eps = idx.docs.slice(-(args.limit || 10)).reverse().map((d) => d.ep);
        return text(id, eps.length ? eps.map((e) => `[${e.app}] ${e.text.slice(0, 140)}`).join('\n') : 'No activity captured yet. Run `continuum start`.');
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool: ${name}` } };
    }
    default:
      return id != null ? { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } } : null; // notifications get no reply
  }
}

const rl = createInterface({ input: process.stdin });
console.error('continuum mcp server ready (stdio)');
for await (const line of rl) {
  const s = line.trim(); if (!s) continue;
  let req; try { req = JSON.parse(s); } catch { continue; }
  const res = await handle(req); if (res) send(res);
}
