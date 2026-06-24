#!/usr/bin/env node
// Continuum CLI — the "shovel". Install once, configure a couple of keys (or go fully
// local), and stream your context. Build use cases on top via the importable modules
// or the MCP server.
//
//   continuum verify          60-second proof it works (no keys, no permissions)
//   continuum start           run event-driven capture → pipeline (persists locally)
//   continuum dashboard       open the local timeline + search at http://localhost:3939
//   continuum mcp             run the MCP server (point Claude Desktop / agents at this)
//   continuum doctor          check the environment + resolved config
//   continuum config          print resolved config (keys redacted)
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, buildDeps, redacted, DATA_DIR } from '../daemon/config.mjs';
import { Pipeline } from '../daemon/pipeline.mjs';
import { appendEpisode } from '../daemon/store.mjs';
import { localEmbedder } from '../daemon/adapters.mjs';
import { watchFiles } from '../daemon/stage1/files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE1 = path.join(HERE, '..', 'daemon', 'stage1');
const cmd = process.argv[2] || 'help';

const hasSwiftc = () => { try { execFileSync('swiftc', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

// Resolve a native capture helper ('screen' | 'capture'), building it on first use. The npm
// package ships only the .swift source (binaries are platform-specific + unsigned), so we
// compile into ~/.continuum/bin/ — user-writable, no touching global node_modules.
function ensureHelper(name) {
  const inPlace = path.join(STAGE1, name);                       // dev/clone: built next to source
  if (fs.existsSync(inPlace)) return inPlace;
  const userBin = path.join(DATA_DIR, 'bin', name);
  if (fs.existsSync(userBin)) return userBin;                    // previously auto-built
  const src = path.join(STAGE1, `${name}.swift`);
  if (process.platform !== 'darwin') { console.error('Native capture is macOS-only for now.'); return null; }
  if (!fs.existsSync(src)) { console.error(`capture source missing: ${src}`); return null; }
  if (!hasSwiftc()) { console.error('Screen capture needs Swift. Install Xcode Command Line Tools:\n  xcode-select --install\nthen run `continuum start` again.'); return null; }
  fs.mkdirSync(path.join(DATA_DIR, 'bin'), { recursive: true });
  console.error(`building the ${name} capture helper (first run, ~10s)…`);
  try { execFileSync('swiftc', [src, '-o', userBin], { stdio: 'inherit' }); return userBin; }
  catch { console.error('build failed — ensure Xcode Command Line Tools are installed (xcode-select --install).'); return null; }
}

function doctor() {
  const cfg = loadConfig();
  const has = (p) => fs.existsSync(p);
  console.log('continuum doctor\n');
  console.log(`  node            ${process.version}`);
  console.log(`  capture source  ${cfg.capture.source}`);
  const builtHelper = has(path.join(STAGE1, cfg.capture.source)) || has(path.join(DATA_DIR, 'bin', cfg.capture.source));
  console.log(`  capture helper  ${builtHelper ? '✓ built' : hasSwiftc() ? '○ builds on first `continuum start`' : '✗ needs Swift — run: xcode-select --install'}`);
  console.log(`  files watched   ${cfg.files.watch.length ? cfg.files.watch.join(', ') : '(none — set files.watch in config)'}`);
  console.log(`  data dir        ${DATA_DIR} ${has(DATA_DIR) ? '✓' : '(created on first run)'}`);
  console.log(`  tier            ${cfg.tier}`);
  console.log(`  embeddings      ${cfg.embeddings.provider}${cfg.embeddings.model ? ' · ' + cfg.embeddings.model : ''}`);
  console.log(`  llm             ${cfg.llm.provider}${cfg.llm.model ? ' · ' + cfg.llm.model : ''}`);
  console.log(`  graph           ${cfg.graph.enabled ? 'enabled · ' + cfg.graph.url : 'off (free tier)'}`);
  console.log(`  openai key      ${cfg.keys.openai ? '✓' : '—'}     anthropic key  ${cfg.keys.anthropic ? '✓' : '—'}`);
  if (cfg.embeddings.provider === 'local') console.log('\n  note: hashed local embedder (instant, zero-dep). For quality local: `ollama pull nomic-embed-text` + set embeddings.provider=ollama. For best: add an OpenAI key.');
}

// Built-in sample of a short work session — proves the whole pipeline with no setup.
const SAMPLE = [
  ['Mail', 'Mail|draft', 'composing an email to the design team about the pitch deck timeline and the demo flow'],
  ['Mail', 'Mail|draft', 'email to the design team: lets finalize the pitch deck visuals before friday review'],
  ['Browser', 'Browser|neo4j', 'reading neo4j documentation about temporal graph indexes and cypher queries'],
  ['Browser', 'Browser|neo4j', 'neo4j vector index setup and bolt connection for the knowledge graph store'],
  ['Code', 'Code|seg', 'implementing the segmentation state machine with simhash dedup and idle boundaries'],
].map(([app, wid, text], i) => ({ t: i * 60_000, source: 'ax', app, window_id: wid, text }));

async function verify() {
  const p = new Pipeline({ embed: localEmbedder(), segmenterOpts: { minActiveMs: 0, minTokens: 0, idleMs: 90_000 } });
  for (const ev of SAMPLE) await p.ingest(ev);
  await p.flush();
  console.log(`continuum verify\n\n  captured ${p.episodes.length} episodes from a sample work session.\n`);
  for (const q of ['what was I emailing the design team about?', 'what neo4j documentation was I reading?']) {
    const r = await p.search(q, { now: 9_000_000 });
    console.log(`  Q: ${q}`);
    console.log(`  → [${r[0].ep.app}] ${r[0].ep.text}\n`);
  }
  console.log('  ✅ capture → segment → index → retrieve works. Next: `continuum start` (live) or `continuum mcp` (into Claude).');
}

async function start() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const cfg = loadConfig();
  const deps = buildDeps(cfg);
  const source = process.env.CONTINUUM_CAPTURE || cfg.capture.source;   // screen (default) | ax
  console.error(`continuum: tier=${deps.tier} capture=${source} embed=${cfg.embeddings.provider} graph=${deps.graphEnabled ? 'on' : 'off'} → ${DATA_DIR}/episodes.ndjson\n`);

  const p = new Pipeline({
    embed: deps.embed,
    onEpisode: (ep) => { appendEpisode(ep); console.error(`  episode [${ep.app}] ${ep.close_reason} sal=${ep.salience} ${ep.text.slice(0, 70)}…`); },
  });

  // Serialize ingests — the segmenter's state isn't concurrency-safe, and we feed it from
  // multiple sources (screen capture + file watcher).
  const PAUSE = path.join(DATA_DIR, 'paused');   // the dashboard Control toggle drops/removes this file
  let q = Promise.resolve();
  const ingest = (ev) => { if (fs.existsSync(PAUSE)) return; q = q.then(() => p.ingest(ev)).catch(() => {}); };
  const onLine = (line) => { const s = line.trim(); if (!s) return; try { ingest(JSON.parse(s)); } catch { /* skip bad line */ } };

  if (process.argv.includes('--stdin')) {
    createInterface({ input: process.stdin }).on('line', onLine);
  } else {
    const bin = ensureHelper(source);   // builds on first run if needed
    if (!bin) return;                   // ensureHelper printed why
    const env = { ...process.env, CONTINUUM_EXCLUDE: [process.env.CONTINUUM_EXCLUDE, ...cfg.capture.exclude].filter(Boolean).join(',') };
    const child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'], env });
    createInterface({ input: child.stdout }).on('line', onLine);
  }

  if (cfg.files.watch.length) { watchFiles(cfg.files.watch, ingest); console.error(`  + watching files in: ${cfg.files.watch.join(', ')}`); }

  process.on('SIGINT', async () => { await q; await p.flush(); process.exit(0); });
}

switch (cmd) {
  case 'verify': await verify(); break;
  case 'doctor': doctor(); break;
  case 'config': console.log(JSON.stringify(redacted(), null, 2)); break;
  case 'start': await start(); break;
  case 'dashboard': await import('../daemon/dashboard.mjs'); break;
  case 'mcp': await import('../daemon/mcp-server.mjs'); break;       // stdio JSON-RPC — do not print to stdout
  case 'mcp-install': {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
    const cfgPath = path.join(dir, 'claude_desktop_config.json');
    const server = path.join(HERE, '..', 'daemon', 'mcp-server.mjs');
    let conf = {};
    try { conf = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); fs.copyFileSync(cfgPath, cfgPath + '.bak'); } catch { /* no config yet */ }
    conf.mcpServers = conf.mcpServers || {};
    conf.mcpServers.continuum = { command: process.execPath, args: [server] };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(conf, null, 2) + '\n');
    console.log(`✓ Continuum added to Claude Desktop.\n  ${cfgPath}\n\nLast step: fully quit Claude Desktop (Cmd+Q) and reopen it.\nThen ask it: "what was I working on?"`);
    break;
  }
  case 'mcp-config': {     // for other MCP clients — prints the config to paste yourself
    const server = path.join(HERE, '..', 'daemon', 'mcp-server.mjs');
    console.log(JSON.stringify({ mcpServers: { continuum: { command: process.execPath, args: [server] } } }, null, 2));
    break;
  }
  default:
    console.log('continuum <verify|start|dashboard|mcp-install|doctor|config>\n\n  verify        prove it works in 30s (no setup)\n  start         live capture → local store\n  dashboard     timeline + search at localhost:3939\n  mcp-install   add Continuum to Claude Desktop (one step)\n  mcp-config    print the MCP config (for other clients)\n  doctor        environment check\n  config        resolved config');
}
