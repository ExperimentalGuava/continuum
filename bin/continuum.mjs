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
import { loadConfig, buildDeps, redacted, DATA_DIR, claudeConfigPath, readRawConfig, writeRawConfig } from '../daemon/config.mjs';
import { detectEnvironment, chooseConfig, applyChoice } from '../daemon/detect.mjs';
import { Pipeline } from '../daemon/pipeline.mjs';
import { appendEpisode, loadEpisodes, pruneEpisodes, appendSession, endSession, writeLastAction, appendHeard } from '../daemon/store.mjs';
import { candidates, approve, dismiss, activePreferences } from '../daemon/preferences.mjs';
import { isCommand, runCommand } from '../daemon/stage4/voice.mjs';
import { notify } from '../daemon/notify.mjs';

// Feedback for a completed voice command: an OS toast + a last-action record the dashboard surfaces.
const actionFeedback = (r) => {
  const title = r.action === 'reminder' ? 'Reminder set' : r.action === 'draft' ? 'Draft ready' : 'Continuum';
  notify(title, r.message);
  writeLastAction({ t: Date.now(), ok: r.ok, action: r.action, message: r.message });
};
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
  if (name === 'audio') { console.error('Call transcription has no built helper yet — prototype runs via --stdin (see daemon/stage1/audio-capture/README.md).'); return null; }
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

// Add Continuum's MCP server to Claude Desktop's config (idempotent). Returns the path
// written, or null if Claude Desktop isn't present and `onlyIfPresent` is set.
function installMcp({ onlyIfPresent = false } = {}) {
  const cfgPath = claudeConfigPath();
  if (onlyIfPresent && !fs.existsSync(cfgPath) && !fs.existsSync(path.dirname(cfgPath))) return null;
  const dir = path.dirname(cfgPath);
  const server = path.join(HERE, '..', 'daemon', 'mcp-server.mjs');
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); fs.copyFileSync(cfgPath, cfgPath + '.bak'); } catch { /* no config yet */ }
  conf.mcpServers = conf.mcpServers || {};
  conf.mcpServers.continuum = { command: process.execPath, args: [server] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(conf, null, 2) + '\n');
  return cfgPath;
}

// One-question yes/no prompt. Auto-yes when not attached to a terminal (e.g. piped
// first-run) or when `assumeYes` is set, so setup never blocks an unattended launch.
function confirm(question, assumeYes) {
  if (assumeYes || !process.stdin.isTTY) return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(`${question} [Y/n] `, (a) => { rl.close(); res(!/^n/i.test(a.trim())); }));
}

// Free-text prompt (returns the trimmed line). Empty string when non-interactive.
function prompt(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res((a || '').trim()); }));
}

// `continuum setup` — detect the user's installed AI and adjust the config to match.
async function setup({ assumeYes = false } = {}) {
  console.log('\ncontinuum setup — detecting your AI\n');
  const raw = readRawConfig();
  let det = await detectEnvironment({ fileKeys: raw.keys || {}, claudeConfigPath });

  // No key found → offer to paste one now (interactive only) for higher-quality AI.
  // A pasted key is saved to config so it's picked up from here on; Enter stays local.
  if (!det.keys.openai && !det.keys.anthropic && !assumeYes && process.stdin.isTTY) {
    const entered = await prompt('  No API key found. Paste an OpenAI (sk-…) or Anthropic (sk-ant-…) key for higher-quality AI,\n  or press Enter to stay free + local: ');
    const k = classifyKey(entered);
    if (entered && !k) {
      console.log('  (Unrecognized key format — staying local. Keys start with sk- or sk-ant-.)');
    } else if (k) {
      raw.keys = { ...(raw.keys || {}), [k.provider]: k.key };
      det = { ...det, keys: { ...det.keys, [k.provider]: 'config' } };
      console.log(`  ✓ Saved your ${k.provider} key.`);
    }
  }

  const choice = chooseConfig(det);

  console.log('  Detected:');
  console.log(`    Anthropic key   ${det.keys.anthropic ? '✓ (' + det.keys.anthropic + ')' : '—'}`);
  console.log(`    OpenAI key      ${det.keys.openai ? '✓ (' + det.keys.openai + ')' : '—'}`);
  console.log(`    Ollama          ${det.ollama.running ? '✓ ' + (det.ollama.models.join(', ') || '(no models pulled)') : '— (not running)'}`);
  console.log(`    Claude Desktop  ${det.claudeDesktop ? '✓ installed' : '—'}`);
  console.log('\n  Will configure:');
  console.log(`    LLM             ${choice.llm.provider}${choice.llm.model ? ' · ' + choice.llm.model : ''}`);
  console.log(`    Embeddings      ${choice.embeddings.provider}${choice.embeddings.model ? ' · ' + choice.embeddings.model : ''}`);
  console.log('\n  Why:');
  for (const r of choice.reasons) console.log(`    · ${r}`);
  console.log('');

  if (!(await confirm('Apply this configuration?', assumeYes))) { console.log('  Skipped — nothing changed.'); return; }
  writeRawConfig(applyChoice(raw, choice));
  console.log(`  ✓ Wrote ${DATA_DIR}/config.json`);

  // If Claude Desktop is present, connect Continuum to it so it can use your context.
  if (det.claudeDesktop && await confirm('Connect Continuum to Claude Desktop now?', assumeYes)) {
    const p = installMcp();
    const quit = process.platform === 'win32' ? 'quit Claude Desktop from the tray, then reopen it' : 'quit Claude Desktop (Cmd+Q), then reopen it';
    if (p) console.log(`  ✓ Added Continuum to Claude Desktop (${p}). Last step: ${quit}.`);
  }
  console.log('\n  Done. Run `continuum doctor` to see the resolved setup.\n');
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

  // Activation session: one record per run, so the dashboard can group "what this run collected".
  // daemon.json advertises liveness (pid/session) to the dashboard; the `stop` sentinel is the
  // Windows-safe graceful-stop channel (signals to a detached process are unreliable on Windows).
  const sessionId = `sess_${Date.now()}`;
  const DAEMON = path.join(DATA_DIR, 'daemon.json');
  const STOP = path.join(DATA_DIR, 'stop');
  const LOG = path.join(DATA_DIR, 'daemon.log');
  try { fs.unlinkSync(STOP); } catch { /* no stale sentinel */ }
  appendSession({ id: sessionId, start: Date.now(), host: os.hostname() });
  fs.writeFileSync(DAEMON, JSON.stringify({ pid: process.pid, session: sessionId, start: Date.now(), log: LOG }));

  let captureChild = null, audioChild = null;

  const p = new Pipeline({
    embed: deps.embed,
    segmenterOpts: { fuseAudio: cfg.capture.audio },   // #11: bind spoken utterances to the active visual segment
    sessionId,                                          // stamp every episode with this activation run
    onEpisode: (ep) => { appendEpisode(ep); if (verbose) console.error(`  episode [${ep.app}] ${ep.close_reason} sal=${ep.salience} ${ep.text.slice(0, 70)}…`); },
  });

  // Serialize ingests — the segmenter's state isn't concurrency-safe, and we feed it from
  // multiple sources (screen capture + file watcher).
  const PAUSE = path.join(DATA_DIR, 'paused');   // the dashboard Control toggle drops/removes this file
  let q = Promise.resolve();
  const ingest = (ev) => { if (fs.existsSync(PAUSE)) return; q = q.then(() => p.ingest(ev)).catch(() => {}); };
  const onLine = (line) => {
    const s = line.trim(); if (!s) return;
    let ev; try { ev = JSON.parse(s); } catch { return; }   // skip bad line
    if (ev && ev.source === 'audio') appendHeard(ev.text);   // live transcript for the dashboard
    // A spoken command ("remind me to…" / "draft an email to…") → act on it, don't store as an episode.
    if (ev && ev.source === 'audio' && isCommand(ev.text)) {
      runCommand(ev.text, { llm: deps.llm }).then(actionFeedback).catch(() => {});
      return;
    }
    ingest(ev);
  };

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
    captureChild = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'], env });
    createInterface({ input: captureChild.stdout }).on('line', onLine);

    // Call transcription (#10) — OPT-IN, OFF BY DEFAULT. Reconciled lifecycle so the dashboard toggle
    // and the instant kill-switch take effect WITHOUT a restart: the helper runs only while the master
    // flag is on AND no `audio-off` sentinel exists. "off" means no process, immediately — important
    // for a call-recording feature. On-device, transcribe-then-delete; the helper tags each utterance
    // speaker:'you'|'them' (mic vs process loopback), and per-speaker egress keeps the remote party local.
    // Mic: the daemon spawns the on-device listener ITSELF when the Mic switch is on — no separate
    // command. (Prototype uses the Python whisper listener; the fleet build will fold this into the
    // Rust helper.) Reconciled live so the dashboard switch / kill sentinel applies without a restart.
    const AUDIO_OFF = path.join(DATA_DIR, 'audio-off');
    const LISTENER = path.join(STAGE1, 'audio-capture', 'continuum_listen.py');
    let audioUnavailable = false;
    const audioWanted = () => loadConfig().capture.audio && !fs.existsSync(AUDIO_OFF);
    const startAudio = () => {
      if (audioChild || audioUnavailable) return;
      if (!fs.existsSync(LISTENER)) { audioUnavailable = true; return; }
      const py = process.platform === 'win32' ? 'python' : 'python3';
      audioChild = spawn(py, [LISTENER], { stdio: ['ignore', 'pipe', 'inherit'], env });
      audioChild.on('error', () => { audioChild = null; audioUnavailable = true; console.error('  mic: could not start listener — install Python + deps: pip install numpy sounddevice webrtcvad-wheels faster-whisper'); });
      createInterface({ input: audioChild.stdout }).on('line', onLine);
      audioChild.on('exit', () => { audioChild = null; });
      console.error('  + mic listening (on-device transcription)');
    };
    const stopAudio = () => { if (audioChild) { try { audioChild.kill(); } catch { /* gone */ } audioChild = null; console.error('  + mic stopped'); } };
    if (audioWanted()) startAudio();
    setInterval(() => { if (audioWanted()) startAudio(); else stopAudio(); }, 2000);
  }

  if (cfg.files.watch.length) { watchFiles(cfg.files.watch, ingest); console.error(`  + watching files in: ${cfg.files.watch.join(', ')}`); }

  // Graceful shutdown: flush open segments, kill capture children, stamp the session end, clear the
  // liveness/sentinel files. Shared by Ctrl-C (SIGINT/SIGTERM) and the dashboard's stop sentinel.
  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return; stopping = true;
    try { await q; } catch { /* drain */ }
    try { await p.flush(); } catch { /* flush open segments */ }
    try { captureChild?.kill(); } catch { /* gone */ }
    try { audioChild?.kill(); } catch { /* gone */ }
    try { endSession(sessionId); } catch { /* stamp session end */ }
    try { fs.unlinkSync(DAEMON); } catch { /* already gone */ }
    try { fs.unlinkSync(STOP); } catch { /* already gone */ }
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  // Windows-safe stop: the dashboard writes the `stop` sentinel; poll for it. The interval also keeps
  // this (possibly detached) process alive when capture is event-driven and otherwise idle.
  setInterval(() => { if (fs.existsSync(STOP)) shutdown(0); }, 1000);
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
  case 'digest': {    // post (or print) a summary of open commitments — run on a schedule for proactive reminders
    const cfg = loadConfig();
    const { llm } = buildDeps(cfg);
    const { openTasks } = await import('../daemon/stage4/tasks.mjs');
    const { formatDigest, deliverDigest } = await import('../daemon/stage4/digest.mjs');
    const text = formatDigest(await openTasks(loadEpisodes(), { llm }));
    if (process.argv.includes('--print') || !cfg.digest.webhook) {
      console.log(text);
      if (!cfg.digest.webhook) console.error('\n(set digest.webhook in ~/.continuum/config.json to post this to Teams/Slack)');
    } else {
      const res = await deliverDigest(text, { webhook: cfg.digest.webhook });
      console.log(res.ok ? '✓ digest delivered' : `✗ delivery failed: ${res.reason || res.status}`);
    }
    break;
  }
  case 'extract': {    // structured, typed content from captures: email/message/ticket/action + Office aggregates
    const cfg = loadConfig();
    const { llm } = buildDeps(cfg);
    const { extractRecords } = await import('../daemon/stage4/extract.mjs');
    const { records, office } = await extractRecords(loadEpisodes(), { llm, egress: cfg.capture.egress });
    console.log('continuum extract — structured content from your captures\n');
    const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString() : '');
    const by = {};
    for (const r of records) (by[r.kind] ||= []).push(r);
    for (const k of ['email', 'message', 'ticket', 'action']) {
      const rs = by[k]; if (!rs || !rs.length) continue;
      console.log(`${k.toUpperCase()} (${rs.length})`);
      for (const r of rs.slice(0, 20)) {
        if (k === 'email') console.log(`  ${r.direction === 'out' ? '→' : '←'} ${r.from || '?'} · ${r.subject || '(no subject)'} · ${r.when || fmtWhen(r.at)}`);
        else if (k === 'ticket') { const ttl = r.title || '(untitled)'; const head = r.key && !ttl.includes(r.key) ? r.key + ' ' : ''; console.log(`  • ${head}${ttl}${r.due ? ' · due ' + r.due : ''} · ${r.status}`); }
        else if (k === 'message') console.log(`  • ${r.owner === 'me' ? 'me' : 'them'}: ${(r.text || '').slice(0, 80)}`);
        else console.log(`  • ${r.what}`);
      }
      console.log('');
    }
    if (office.length) {
      console.log(`OFFICE FILES (${office.length})`);
      for (const o of office.slice(0, 20)) console.log(`  • ${o.file} · ${Math.round(o.dwellMs / 60000)}m · ${o.touches} touch(es)`);
      console.log('');
    }
    if (!records.length && !office.length) console.log('  (nothing structured yet — run `continuum start` and work in your apps)');
    console.log(`  ${records.length} record(s) · ${llm ? 'heuristic + Claude' : 'heuristic only — add a key for the LLM pass'}`);
    break;
  }
  case 'remind': {     // the "reminding/useful" surface: explicit reminders + open commitments + due tickets
    const { completeReminder } = await import('../daemon/store.mjs');
    const { remindList, addReminder } = await import('../daemon/stage4/reminders.mjs');
    const sub = process.argv[3];
    if (sub === 'add') {
      const text = process.argv.slice(4).join(' ');
      if (!text) { console.log('usage: continuum remind add "<what to remember>"'); break; }
      const r = addReminder(text);
      console.log(`✓ reminder set: ${r.text}${r.dueMs ? ' · due ' + new Date(r.dueMs).toLocaleDateString() : ''}`);
      break;
    }
    if (sub === 'done') {
      const id = process.argv[4];
      console.log(id && completeReminder(id) ? `✓ done: ${id}` : 'no such reminder id (run `continuum remind`).');
      break;
    }
    const cfg = loadConfig();
    const { llm } = buildDeps(cfg);
    const items = await remindList(loadEpisodes(), { llm, egress: cfg.capture.egress });
    console.log('continuum remind — what to stay on top of\n');
    if (!items.length) { console.log('  (nothing pressing — all clear, or nothing captured yet)'); break; }
    const icon = { reminder: '🔔', commitment: '•', waiting: '⏳', ticket: '🎫' };
    for (const it of items.slice(0, 30)) {
      const due = it.dueMs ? ` · due ${new Date(it.dueMs).toLocaleDateString()}` : '';
      const flag = it.status === 'overdue' ? '  ⚠ OVERDUE' : '';
      const who = it.kind === 'waiting' ? ' (awaiting other)' : '';
      console.log(`  ${icon[it.kind] || '•'} ${it.text}${due}${who}  · ${it.source}${flag}`);
    }
    console.log(`\n  ${items.length} item(s) · ${llm ? 'heuristic + Claude' : 'heuristic only — add a key for the LLM pass'}`);
    console.log('  continuum remind add "<text>"   ·   continuum remind done <id>');
    break;
  }
  case 'say': {        // run a voice-command transcript directly — the seam the mic supervisor calls
    const text = process.argv.slice(3).join(' ');
    if (!text) { console.log('usage: continuum say "<command>"   e.g. "remind me to call the auditor friday"'); break; }
    const { llm } = buildDeps();
    const r = await runCommand(text, { llm });
    actionFeedback(r);
    console.log(r.message);
    break;
  }
  case 'dashboard': await import('../daemon/dashboard.mjs'); break;
  case 'app': {
    // Native-feeling desktop window: start the local dashboard server, then open it in a
    // chromeless app window (own icon, no browser chrome). Same local server, not a tab.
    const port = process.env.CONTINUUM_PORT || process.env.PORT || 3939;
    const url = `http://localhost:${port}`;
    await import('../daemon/dashboard.mjs');            // starts listening on `port`
    const { openAppWindow } = await import('../daemon/app-window.mjs');
    // Give the server a moment to bind, then open the window.
    setTimeout(() => {
      const native = openAppWindow(url);
      console.error(native ? `continuum → opened app window at ${url}` : `continuum → opened ${url} in your browser`);
    }, 600);
    break;
  }
  case 'mcp': await import('../daemon/mcp-server.mjs'); break;       // stdio JSON-RPC — do not print to stdout
  case 'setup': await setup({ assumeYes: process.argv.includes('--yes') || process.argv.includes('-y') }); break;
  case 'mcp-install': {
    const cfgPath = installMcp();
    const quit = process.platform === 'win32' ? 'fully quit Claude Desktop (right-click the tray icon → Quit)' : 'fully quit Claude Desktop (Cmd+Q)';
    console.log(`✓ Continuum added to Claude Desktop.\n  ${cfgPath}\n\nLast step: ${quit} and reopen it.\nThen ask it: "what was I working on?"`);
    break;
  }
  case 'mcp-config': {     // for other MCP clients — prints the config to paste yourself
    const server = path.join(HERE, '..', 'daemon', 'mcp-server.mjs');
    console.log(JSON.stringify({ mcpServers: { continuum: { command: process.execPath, args: [server] } } }, null, 2));
    break;
  }
  default:
    console.log('continuum <setup|verify|start|dashboard|mcp-install|preferences|doctor|config|prune|eval>\n\n  setup         detect your installed AI (Ollama/OpenAI/Anthropic) + configure to match\n  verify        prove it works in 30s (no setup)\n  start         live capture → local store\n  dashboard     timeline + search at localhost:3939\n  app           same dashboard in a native app window (no browser tab)\n  mcp-install   add Continuum to Claude Desktop (one step)\n  mcp-config    print the MCP config (for other clients)\n  preferences   review + curate how your agents work for you\n  doctor        environment check\n  config        resolved config\n  prune [days]  discharge raw episodes older than the retention window\n  tasks         open commitments from your correspondence (not yet closed)\n  extract       structured records: email/message/ticket/action + Office activity\n  remind        what to stay on top of (reminders + open commitments + due tickets)\n  say "<cmd>"   run a voice command (remind me to… / draft an email to…)\n  digest        post/print a summary of open commitments (run on a schedule)\n  eval          capture/perception quality over local fixtures');
}
