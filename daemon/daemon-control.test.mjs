// Run with an isolated data dir:  CONTINUUM_DATA=$(mktemp -d) node daemon/daemon-control.test.mjs
import fs from 'node:fs';
import { DATA_DIR } from './config.mjs';
import { appendEpisode, appendSession, endSession } from './store.mjs';
import { daemonState, sessions, DAEMON_FILE, STOP_FILE } from './daemon-control.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nDaemon control (activation + sessions)\n');

fs.mkdirSync(DATA_DIR, { recursive: true });

// --- liveness / status ---
ok('no daemon.json → not running', daemonState().running === false);

fs.writeFileSync(DAEMON_FILE, JSON.stringify({ pid: process.pid, session: 'sess_live', start: 42 }));
const live = daemonState();
ok('daemon.json with a live pid → running', live.running === true && live.session === 'sess_live' && live.start === 42);

// a pid that doesn't exist → reaped + reported stopped
fs.writeFileSync(DAEMON_FILE, JSON.stringify({ pid: 2147480000, session: 'sess_dead', start: 1 }));
ok('stale daemon.json (dead pid) → not running', daemonState().running === false);
ok('stale daemon.json is reaped', !fs.existsSync(DAEMON_FILE));

ok('stopping reflects the stop sentinel', (fs.writeFileSync(STOP_FILE, '1'), daemonState().stopping === true));
fs.unlinkSync(STOP_FILE);

// --- session aggregation ---
appendSession({ id: 'sess_1', start: 1000, host: 'pc' }); endSession('sess_1', 4000);
appendSession({ id: 'sess_2', start: 5000, host: 'pc' });   // no end → still open
appendEpisode({ id: 'e1', app: 'Mail',  text: 'run 1 a', session_id: 'sess_1', end: 1500 });
appendEpisode({ id: 'e2', app: 'Mail',  text: 'run 1 b', session_id: 'sess_1', end: 2500 });
appendEpisode({ id: 'e3', app: 'Teams', text: 'run 2 a', session_id: 'sess_2', end: 5500 });
appendEpisode({ id: 'e4', app: 'Jira',  text: 'old, no session', end: 10 });

const rows = sessions();
const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
ok('sessions newest-first', rows[0].id === 'sess_2', `first=${rows[0].id}`);
ok('per-session episode counts', byId.sess_1.episodes === 2 && byId.sess_2.episodes === 1, JSON.stringify(rows.map((r) => [r.id, r.episodes])));
ok('per-session top apps', byId.sess_1.apps.includes('Mail') && byId.sess_2.apps.includes('Teams'));
ok('finished session keeps its end', byId.sess_1.end === 4000);
ok('legacy bucket collects session-less episodes', byId._legacy && byId._legacy.episodes === 1 && byId._legacy.legacy === true);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
