// Run with an isolated data dir:  CONTINUUM_DATA=$(mktemp -d) node daemon/stage4/reminders.test.mjs
import { remindList, addReminder } from './reminders.mjs';
import { completeReminder } from '../store.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 4 reminders (the reminding/useful surface)\n');

const DAY = 864e5;
const NOW = Date.now();

// explicit reminder with a due phrase
const r = addReminder('follow up with Sarah on the pricing deck tomorrow', { now: NOW });
ok('addReminder parses a due date', typeof r.dueMs === 'number' && r.dueMs > NOW, `dueMs=${r.dueMs}`);

const episodes = [
  // a commitment YOU made, with a due date → commitment/overdue logic
  { id: 'e1', app: 'outlook', title: 'Inbox - Outlook', end: NOW - DAY, source_mix: ['uia'], label: { type: 'message' }, text: "I'll send the budget by friday." },
  // something asked of you by someone else → waiting / assigned
  { id: 'e2', app: 'teams', title: 'Chat | Microsoft Teams', end: NOW, source_mix: ['uia'], label: { type: 'message' }, text: 'Can you review the deck before the meeting?' },
  // a ticket with a due date
  { id: 'e3', app: 'chrome', title: 'PROJ-9 Ship report - Jira', url_host: 'acme.atlassian.net', end: NOW, source_mix: ['uia'], text: 'PROJ-9 Ship report. Please complete by tomorrow.' },
  // pure reading — must NOT become a reminder
  { id: 'e4', app: 'chrome', title: 'Some blog', url_host: 'example.com', end: NOW, source_mix: ['ocr'], text: 'an article about gardening tips for spring' },
];

const items = await remindList(episodes, { now: NOW });
const kinds = items.map((i) => i.kind);
ok('explicit reminder surfaces', items.some((i) => i.kind === 'reminder' && /Sarah/.test(i.text)));
ok('your commitment surfaces', items.some((i) => i.kind === 'commitment'));
ok('a ticket with a due date surfaces', items.some((i) => i.kind === 'ticket'));
ok('noise (reading) does NOT surface', !items.some((i) => /gardening/.test(i.text)), JSON.stringify(items.map((i) => i.text)));

// ranking: anything overdue ranks ahead of non-due items
const firstDue = items.find((i) => i.status === 'overdue' || i.dueMs);
ok('due/overdue items rank near the top', items.indexOf(firstDue) <= 1, `order=${kinds.join(',')}`);

// completing the explicit reminder drops it
completeReminder(r.id);
const after = await remindList(episodes, { now: NOW });
ok('completed reminder no longer surfaces', !after.some((i) => i.id === r.id));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
