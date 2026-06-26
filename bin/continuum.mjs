#!/usr/bin/env node
// Continuum CLI — the "shovel". Install once, configure a couple of keys (or go fully
// local), and stream your context. Build use cases on top via the importable modules
// or the MCP server.
//
//   continuum verify          60-second proof it works (no keys, no permissions)
//   continuum start           run event-driven capture → pipeline (persists locally)
//   continuum dashboard       open the local timeline + search at http://localhost:3939
//   continuum mcp             run the MCP server (point Claude Desktop / agents at this)
//   continuum preferences     review + curate how your agents work for you
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
import { appendEpisode, loadEpisodes, pruneEpisodes } from '../daemon/store.mjs';
import { candidates, approve, dismiss, activePreferences } from '../daemon/preferences.mjs';
import { localEmbedder } from '../daemon/adapters.mjs';
import { watchFiles } from '../daemon/stage1/files.mjs';
import { runEval, formatReport } from '../daemon/eval/eval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGE1 = path.join(HERE, '..', 'daemon', 'stage1');
const cmd = process.argv[2] || 'help';

const hasSwiftc = () => { try { execFileSync('swiftc', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const hasCargo = () => { try { execFileSync('cargo', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

// Windows capture helper — the Rust OCR daemon (daemon/stage1/win-capture). Same drop-in NDJSON
// contract as the Swift helper; built on first use via cargo, mirroring the swiftc path below.
// 'screen' and 'ax' both map to it for now (the OCR daemon is the universal path; a UIA-based
// accelerator is a later addition). Audio capture isn't available on Windows yet.
function ensureWinHelper(name) {
  if (name === 'audio') { console.error('Audio capture is not available on Windows yet.'); return null; }
  const exe = 'continuum-capture.exe';
  const crate = path.join(STAGE1, 'win-capture');
  const built = path.join(crate, 'target', 'release', exe);     // dev/clone: cargo's output dir
  if (fs.existsSync(built)) return built;
  const userBin = path.join(DATA_DIR, 'bin', exe);
  if (fs.existsSync(userBin)) return userBin;                    // shipped/copied prebuilt binary
  if (!fs.existsSync(path.join(crate, 'Cargo.toml'))) { console.error(`Windows capture source missing: ${crate}`); return null; }
  if (!hasCargo()) { console.error('Windows capture needs Rust. Install from https://rustup.rs, then run `continuum start` again.'); return null; }
  console.error('building the Windows capture daemon (first run, ~1–2 min)…');
  try { execFileSync('cargo', ['build', '--release'], { cwd: crate, stdio: 'inherit' }); return built; }
  catch { console.error('build failed — ensure Rust is installed (https://rustup.rs) and try again.'); return null; }
}

// Resolve a native capture helper ('screen' | 'capture'), building it on first use. The npm
// package ships only source (binaries are platform-specific + unsigned), so we compile into
// the crate's target/ or ~/.continuum/bin/ — user-writable, no touching global node_modules.
function ensureHelper(name) {
  if (process.platform === 'win32') return ensureWinHelper(name);
  const inPlace = path.join(STAGE1, name);                       // dev/clone: built next to source
  if (fs.existsSync(inPlace)) return inPlace;
  const userBin = path.join(DATA_DIR, 'bin', name);
  if (fs.existsSync(userBin)) return userBin;                    // previously auto-built
  const src = path.join(STAGE1, `${name}.swift`);
  if (process.platform !== 'darwin') { console.error('Native capture is supported on macOS and Windows.'); return null; }
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
  if (process.platform === 'win32') {
    const exe = path.join(STAGE1, 'win-capture', 'target', 'release', 'continuum-capture.exe');
    const builtHelper = has(exe) || has(path.join(DATA_DIR, 'bin', 'continuum-capture.exe'));
    console.log(`  capture helper  ${builtHelper ? '✓ built' : hasCargo() ? '○ builds on first `continuum start`' : '✗ needs Rust — install from https://rustup.rs'}`);
  } else {
    const builtHelper = has(path.join(STAGE1, cfg.capture.source)) || has(path.join(DATA_DIR, 'bin', cfg.capture.source));
    console.log(`  capture helper  ${builtHelper ? '✓ built' : hasSwiftc() ? '○ builds on first `continuum start`' : '✗ needs Swift — run: xcode-select --install'}`);
  }
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
  // Retention discharge runs at startup (before capture, so no append races): drop raw episodes
  // past the window. Task-linked episodes are kept once #4 lands (isPinned hook). For a long-lived
  // session, schedule `continuum prune` (or restart) to discharge periodically.
  if (cfg.retention.days > 0) {
    const { pruned, remaining } = pruneEpisodes({ days: cfg.retention.days });
    if (pruned) console.error(`  retention: discharged ${pruned} episode(s) older than ${cfg.retention.days}d (${remaining} kept)`);
  }
  const deps = buildDeps(cfg);
  const source = process.env.CONTINUUM_CAPTURE || cfg.capture.source;   // screen (default) | ax
  // Capture SILENTLY by default: a terminal showing per-episode logs gets OCR'd back in, creating a
  // self-referential feedback loop (and OCR mangles any skip-markers we'd match on — brittle). The
  // durable fix is to not print the noise. Set CONTINUUM_VERBOSE=1 to watch episodes scroll.
  const verbose = process.env.CONTINUUM_VERBOSE === '1';
  console.error(`continuum: capturing (${source}, ${cfg.embeddings.provider}) → ${DATA_DIR} · silent (CONTINUUM_VERBOSE=1 to see episodes)\n`);

  const p = new Pipeline({
    embed: deps.embed,
    segmenterOpts: { fuseAudio: cfg.capture.audio },   // #11: bind spoken utterances to the active visual segment
    onEpisode: (ep) => { appendEpisode(ep); if (verbose) console.error(`  episode [${ep.app}] ${ep.close_reason} sal=${ep.salience} ${ep.text.slice(0, 70)}…`); },
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
    const env = {
      ...process.env,
      CONTINUUM_EXCLUDE: [process.env.CONTINUUM_EXCLUDE, ...cfg.capture.exclude].filter(Boolean).join(','),
      CONTINUUM_ALLOW: (cfg.capture.allow || []).join(','),   // capture only the configured work apps ([] = all)
    };
    const child = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'], env });
    createInterface({ input: child.stdout }).on('line', onLine);

    if (cfg.capture.audio) {   // #10: opt-in meeting capture (mic + system audio), on-device, transcribe-then-delete
      const abin = ensureHelper('audio');
      if (abin) {
        const ac = spawn(abin, [], { stdio: ['ignore', 'pipe', 'inherit'], env });
        createInterface({ input: ac.stdout }).on('line', onLine);
        console.error('  + audio capture on (meetings; on-device, transcribe-then-delete)');
      }
    }
  }

  if (cfg.files.watch.length) { watchFiles(cfg.files.watch, ingest); console.error(`  + watching files in: ${cfg.files.watch.join(', ')}`); }

  process.on('SIGINT', async () => { await q; await p.flush(); process.exit(0); });
}

// continuum preferences — review how the agent has learned you want it to work, and curate it.
// Preferences you've clearly stated apply automatically; the rest wait for your okay. Active prefs
// ride into every agent via the MCP instructions, applied silently.
async function preferences() {
  const sub = process.argv[3];
  const arg = process.argv[4];
  if (sub === 'approve' || sub === 'dismiss' || sub === 'off' || sub === 'remove') {
    if (!arg) { console.log(`usage: continuum preferences ${sub} <number|id>`); return; }
    if (sub === 'off' || sub === 'remove') {                   // turn off an active one (won't reapply)
      const active = activePreferences(loadEpisodes());
      const p = /^\d+$/.test(arg) ? active[+arg - 1] : active.find((x) => x.id === arg);
      if (!p) { console.log('no such active preference — run `continuum preferences`.'); return; }
      dismiss(p.id); console.log(`✓ turned off: ${p.text}`);
      return;
    }
    const { llm } = buildDeps();
    const cands = await candidates(loadEpisodes(), { llm });
    const p = /^\d+$/.test(arg) ? cands[+arg - 1] : cands.find((x) => x.id === arg);
    if (!p) { console.log('no such suggestion — run `continuum preferences` to see the numbered list.'); return; }
    if (sub === 'approve') { approve(p); console.log(`✓ approved — your agents will apply this:\n  ${p.text}`); }
    else { dismiss(p.id); console.log(`✓ dismissed: ${p.text}`); }
    return;
  }
  // default: list active + suggested
  const { llm } = buildDeps();
  const eps = loadEpisodes();
  const active = activePreferences(eps);
  const cands = await candidates(eps, { llm });
  console.log('continuum preferences — how your agents work for you\n');
  console.log('Active (applied by default in every agent session, silently):');
  if (active.length) active.forEach((p, i) => console.log(`  ${i + 1}. ${p.text}  ·  ${p.kind} · ${p.applied === 'auto' ? 'auto-applied' : 'approved'}`));
  else console.log('  (none yet — approve a suggestion, or state a preference a couple of times and it turns on by itself)');
  console.log('\nSuggested (learned from your activity — approve to apply):');
  if (cands.length) cands.forEach((p, i) => console.log(`  ${i + 1}. ${p.text}  ·  ${p.kind} · ${Math.round(p.confidence * 100)}% · ${p.source}`));
  else console.log('  (nothing new — keep working, or curate in the dashboard)');
  console.log('\n  continuum preferences approve <number>    apply a suggestion');
  console.log('  continuum preferences dismiss <number>    hide a suggestion');
  console.log('  continuum preferences off     <number>    turn off an active one (won\'t reapply)');
  console.log('  (or curate visually in the dashboard → Preferences)');
}

switch (cmd) {
  case 'verify': await verify(); break;
  case 'preferences': case 'prefs': await preferences(); break;
  case 'doctor': doctor(); break;
  case 'config': console.log(JSON.stringify(redacted(), null, 2)); break;
  case 'eval': console.log(formatReport(await runEval())); break;       // capture/perception quality over local fixtures
  case 'start': await start(); break;
  case 'prune': {     // discharge raw episodes older than the retention window (schedulable)
    const cfg = loadConfig();
    const days = process.argv[3] ? Number(process.argv[3]) : cfg.retention.days;
    const { pruned, remaining } = pruneEpisodes({ days });
    console.log(`continuum prune\n\n  discharged ${pruned} episode(s) older than ${days}d · ${remaining} kept`);
    break;
  }
  case 'tasks': {     // commitments from your correspondence that you haven't closed (hybrid: heuristic + LLM)
    const { llm } = buildDeps();
    const { openTasks } = await import('../daemon/stage4/tasks.mjs');
    const open = await openTasks(loadEpisodes(), { llm });
    console.log('continuum tasks — commitments you haven\'t closed\n');
    if (!open.length) { console.log('  (nothing open — all clear, or no correspondence captured yet)'); break; }
    for (const t of open) {
      const due = t.dueMs ? ` · due ${new Date(t.dueMs).toLocaleDateString()}` : '';
      const flag = t.status === 'overdue' ? '  ⚠ OVERDUE' : '';
      console.log(`  • ${t.text}${due}  · ${t.app}${flag}`);
    }
    console.log(`\n  ${open.length} open · hybrid extraction (${llm ? 'local + Claude' : 'local heuristics only — add a key for the LLM pass'})`);
    break;
  }
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
    console.log('continuum <verify|start|dashboard|mcp-install|preferences|doctor|config|prune|eval>\n\n  verify        prove it works in 30s (no setup)\n  start         live capture → local store\n  dashboard     timeline + search at localhost:3939\n  mcp-install   add Continuum to Claude Desktop (one step)\n  mcp-config    print the MCP config (for other clients)\n  preferences   review + curate how your agents work for you\n  doctor        environment check\n  config        resolved config\n  prune [days]  discharge raw episodes older than the retention window\n  tasks         open commitments from your correspondence (not yet closed)\n  eval          capture/perception quality over local fixtures');
}
