// Activation control — start/stop the capture daemon and report its status, plus session grouping.
// Kept out of dashboard.mjs (which boots an HTTP server at import) so these can be unit-tested
// without a server. The dashboard imports and exposes them over /api/daemon and /api/sessions.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { loadEpisodes, loadSessions, discardSession } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const CLI = path.join(REPO, 'bin', 'continuum.mjs');   // absolute → works regardless of cwd / PATH

export const DAEMON_FILE = path.join(DATA_DIR, 'daemon.json');
export const STOP_FILE = path.join(DATA_DIR, 'stop');
const LOG_FILE = path.join(DATA_DIR, 'daemon.log');

// process.kill(pid, 0) is a liveness probe on both POSIX and Windows: no signal sent, just a
// permission/existence check. EPERM means the process exists but we can't signal it (still alive).
export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Current daemon status. Reaps a stale daemon.json left by a crash (pid no longer alive).
export function daemonState() {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8')); } catch { /* not running */ }
  const running = !!(d && isAlive(d.pid));
  if (d && !running) { try { fs.unlinkSync(DAEMON_FILE); } catch { /* race */ } }
  return {
    running,
    stopping: fs.existsSync(STOP_FILE),
    pid: running ? d.pid : null,
    session: running ? d.session : null,
    start: running ? d.start : null,
  };
}

// Launch the daemon as a DETACHED background process so it outlives the dashboard. Output goes to
// daemon.log. No-op if one is already running. daemon.json appears once start() writes it.
export function startDaemon() {
  const cur = daemonState();
  if (cur.running) return cur;
  try { fs.unlinkSync(STOP_FILE); } catch { /* none */ }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [CLI, 'start'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    cwd: REPO,
  });
  child.unref();
  return { starting: true, pid: child.pid };
}

// Graceful stop via the sentinel the daemon polls (Windows-safe — see start() in bin/continuum.mjs).
export function stopDaemon() {
  const s = daemonState();
  if (!s.running) return { running: false };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STOP_FILE, String(Date.now()));
  return { stopping: true, pid: s.pid };
}

// One row per activation session, joined with the episodes it produced (count + top apps + span).
// Episodes with no session_id (captured before this feature, or via `--stdin`) bucket under `_legacy`.
export function sessions() {
  const eps = loadEpisodes();
  const byId = new Map();
  for (const e of eps) {
    const k = e.session_id || '_legacy';
    const g = byId.get(k) || { count: 0, apps: new Map(), first: Infinity, last: 0 };
    g.count += 1;
    const app = e.app || 'Unknown';
    g.apps.set(app, (g.apps.get(app) || 0) + 1);
    const t = e.end || e.start || 0;
    if (t) { g.first = Math.min(g.first, t); g.last = Math.max(g.last, t); }
    byId.set(k, g);
  }
  const topApps = (g) => [...g.apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((x) => x[0]);
  const live = daemonState();
  const rows = loadSessions().map((s) => {
    const g = byId.get(s.id) || { count: 0, apps: new Map(), first: 0, last: 0 };
    return {
      id: s.id, start: s.start, end: s.end || null,
      active: live.running && live.session === s.id,
      episodes: g.count, apps: topApps(g),
    };
  });
  if (byId.has('_legacy')) {
    const g = byId.get('_legacy');
    rows.push({ id: '_legacy', start: g.first === Infinity ? 0 : g.first, end: g.last || null, active: false, episodes: g.count, apps: topApps(g), legacy: true });
  }
  return rows.sort((a, b) => (b.start || 0) - (a.start || 0));
}

export { discardSession };
