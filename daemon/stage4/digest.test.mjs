// Run:  node daemon/stage4/digest.test.mjs
import { formatDigest, deliverDigest } from './digest.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 4 — scheduled digest\n');

ok('empty → all caught up', /caught up/.test(formatDigest([], { now: 2000 })));

const tasks = [
  { text: 'Review the pricing deck', status: 'overdue', app: 'Teams', dueMs: 1000 },
  { text: 'Update the migration runbook', status: 'open', app: 'Jira', dueMs: null },
];
const d = formatDigest(tasks, { now: 2000 });
ok('lists both commitments', /pricing deck/.test(d) && /migration runbook/.test(d));
ok('overdue section comes before still-open', d.indexOf('⚠ Overdue') >= 0 && d.indexOf('⚠ Overdue') < d.indexOf('Still open'));
ok('header counts open + overdue', /2 open, 1 overdue/.test(d), d.split('\n')[1]);

let captured = null;
const mockFetch = async (url, opts) => { captured = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200 }; };
const r = await deliverDigest('hello team', { webhook: 'https://hook.example/x', fetchImpl: mockFetch });
ok('delivers to the webhook with {text}', r.ok && captured.url === 'https://hook.example/x' && captured.body.text === 'hello team');

const r2 = await deliverDigest('x', {});
ok('no webhook → not delivered', !r2.ok && /no webhook/.test(r2.reason));

const r3 = await deliverDigest('x', { webhook: 'https://hook', fetchImpl: async () => { throw new Error('network down'); } });
ok('delivery failure is reported, not thrown', !r3.ok && /network down/.test(r3.reason));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
