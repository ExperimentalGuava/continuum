// Run:  node daemon/stage4/tasks.test.mjs
import { extractTasks, openTasks } from './tasks.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 4 — open-task extraction\n');

const DAY = 864e5, T = 1_700_000_000_000, NOW = T + 7 * DAY;

// A captured week of work correspondence.
const eps = [
  { id: 'a', app: 'Outlook', label: { type: 'message', owner: 'me' }, end: T,
    text: "Thanks for the call. I'll send the Q3 report by Friday and follow up with the client." },
  { id: 'b', app: 'Outlook', label: { type: 'message', owner: 'me' }, end: T + 6 * DAY,
    text: 'Sent the Q3 report to the client just now.' },                       // completion signal for (a)
  { id: 'c', app: 'Teams', label: { type: 'message', owner: 'other' }, end: T + DAY,
    text: "Can you review the pricing deck before tomorrow's meeting?" },        // assigned to user, due passes
  { id: 'd', app: 'Jira', label: { type: 'message', owner: 'me' }, end: T + 2 * DAY,
    text: 'Looking at the migration ticket dashboard.' },                        // not a commitment
];

const tasks = await extractTasks(eps, { now: NOW });   // heuristic-only (free, no LLM)
const find = (re) => tasks.find((t) => re.test(t.text.toLowerCase()));

ok('extracts the Q3 report commitment (owner you)', find(/q3 report/)?.owner === 'you', `task=${find(/q3 report/)?.text}`);
ok('Q3 report → done via later "sent" signal', find(/q3 report/)?.status === 'done', `st=${find(/q3 report/)?.status}`);
ok('extracts the pricing-deck assignment', !!find(/pricing deck/));
ok('pricing deck → overdue (due passed, no completion)', find(/pricing deck/)?.status === 'overdue', `st=${find(/pricing deck/)?.status}`);
ok('ignores non-commitment (ticket browsing)', !find(/migration/), `got=${find(/migration/)?.text}`);

// Hybrid: an implied commitment heuristics can't catch, recovered by the LLM on the hard case only.
const eps2 = [{ id: 'e', app: 'Slack', label: { type: 'message', owner: 'me' }, end: T, text: 'Yeah no worries, the onboarding doc is on me.' }];
const mockTaskLLM = async (_s, user) => (/onboarding/.test(user) ? '[{"text":"finish the onboarding doc","owner":"you","due":"","done":false}]' : '[]');

ok('heuristic alone misses the implied commitment', (await extractTasks(eps2, { now: NOW })).length === 0);
const withLlm = await extractTasks(eps2, { now: NOW, llm: mockTaskLLM });
ok('LLM hard-case pass recovers it', withLlm.some((t) => /onboarding/.test(t.text)), `n=${withLlm.length}`);

// "I need to … tomorrow" — the real Outlook-draft phrasing UIA captured
const t2 = await extractTasks(
  [{ id: 'x', app: 'Outlook', label: { type: 'message', owner: 'me' }, end: T, text: 'I need to work on this tomorrow.' }],
  { now: T + 3 * DAY },
);
ok('catches "I need to … tomorrow" (overdue)', t2.some((x) => /work on this/.test(x.text) && x.owner === 'you' && x.status === 'overdue'), `t2=${JSON.stringify(t2.map((x) => x.status))}`);

const open = await openTasks(eps, { now: NOW });
ok('openTasks = only your unclosed commitments, overdue first',
   open.every((t) => t.owner === 'you' && t.status !== 'done') && open[0] && /pricing deck/.test(open[0].text),
   `open=[${open.map((t) => t.status).join(',')}]`);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
