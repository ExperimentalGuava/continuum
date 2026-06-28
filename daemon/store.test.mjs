// Run with an isolated data dir:  CONTINUUM_DATA=$(mktemp -d) node daemon/store.test.mjs
import { appendEpisode, loadEpisodes, loadIndex, pruneEpisodes, appendSession, loadSessions, endSession, discardSession } from './store.mjs';
import { localEmbedder } from './adapters.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStore (persistence)\n');

appendEpisode({ id: 's1', app: 'Mail', text: 'email to the design team about the pitch deck', salience: 0.7, end: 1000 });
appendEpisode({ id: 's2', app: 'Browser', text: 'reading neo4j temporal graph documentation', salience: 0.6, end: 2000 });

const eps = loadEpisodes();
ok('append + load round-trips', eps.length === 2 && eps[0].id === 's1', `n=${eps.length}`);

const idx = await loadIndex(localEmbedder());
const r = await idx.search('design team email', { now: 2000 });
ok('index rebuilds from the store and retrieves', r[0].ep.app === 'Mail', `top=${r[0]?.ep.app}`);

// retention discharge: drop old episodes, keep recent + anything pinned (task-linked)
const NOW = 10 * 864e5;
appendEpisode({ id: 'old', app: 'Mail', text: 'stale thread', end: 1 * 864e5 });          // day 1
appendEpisode({ id: 'recent', app: 'Teams', text: 'fresh thread', end: 9 * 864e5 });       // day 9
appendEpisode({ id: 'old-task', app: 'Jira', text: 'open ticket', end: 1 * 864e5 });       // day 1, task-linked
const pr = pruneEpisodes({ days: 7, now: NOW, isPinned: (e) => e.id === 'old-task' });
const after = loadEpisodes().map((e) => e.id);
ok('prune discharges old, keeps recent + pinned',
   pr.pruned >= 1 && after.includes('recent') && after.includes('old-task') && !after.includes('old'),
   `after=[${after.join(',')}]`);

// --- activation sessions ---
appendSession({ id: 'sess_A', start: 100, host: 'pc' });
appendSession({ id: 'sess_B', start: 200, host: 'pc' });
const sess = loadSessions();
ok('append + load sessions round-trips', sess.length === 2 && sess[0].id === 'sess_A' && sess[1].start === 200, `n=${sess.length}`);

endSession('sess_A', 150);
ok('endSession stamps end', loadSessions().find((s) => s.id === 'sess_A').end === 150);
endSession('sess_A', 999);   // idempotent — must not overwrite
ok('endSession is idempotent', loadSessions().find((s) => s.id === 'sess_A').end === 150);

// discardSession drops only the target session's episodes, and removes its session row
appendEpisode({ id: 'eA', app: 'Mail', text: 'belongs to run A', session_id: 'sess_A', end: 100 });
appendEpisode({ id: 'eB', app: 'Teams', text: 'belongs to run B', session_id: 'sess_B', end: 200 });
const removed = discardSession('sess_A');
const idsAfter = loadEpisodes().map((e) => e.id);
const sessAfter = loadSessions().map((s) => s.id);
ok('discardSession drops only that run’s episodes',
   removed === 1 && !idsAfter.includes('eA') && idsAfter.includes('eB'),
   `removed=${removed} ids=[${idsAfter.join(',')}]`);
ok('discardSession removes the session row', !sessAfter.includes('sess_A') && sessAfter.includes('sess_B'), `sess=[${sessAfter.join(',')}]`);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
