// Run with an isolated data dir:  CONTINUUM_DATA=$(mktemp -d) node daemon/notify.test.mjs
import { notify } from './notify.mjs';
import { writeLastAction, readLastAction } from './store.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nNotifications (voice feedback channel)\n');

// notify must never throw — a failed toast can't be allowed to break capture. (Off-Windows it logs.)
let threw = false;
try { notify('Reminder set', 'call the auditor friday'); } catch { threw = true; }
ok('notify() never throws', !threw);
try { notify(undefined, undefined); } catch { threw = true; }
ok('notify() tolerates empty title/body', !threw);

// last-action surface the dashboard polls
ok('readLastAction is null before any action', readLastAction() === null);
writeLastAction({ t: 123, ok: true, action: 'draft', message: 'Draft ready to Priya' });
const la = readLastAction();
ok('writeLastAction → readLastAction round-trips', la && la.t === 123 && la.action === 'draft' && /Priya/.test(la.message), JSON.stringify(la));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
