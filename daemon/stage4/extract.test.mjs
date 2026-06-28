// Tests for Stage 4 typed extraction. Run: node daemon/stage4/extract.test.mjs
import { classifyKind, extractRecord, aggregateOffice, extractRecords } from './extract.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 4 typed extraction\n');

const NOW = Date.now();
const emailEp = {
  id: 'e1', app: 'outlook', title: 'Inbox - Outlook', end: NOW, source_mix: ['uia'], label: { type: 'message' },
  text: 'From Boardy Boardman, Subject I just broke Google Calendar, Received Sat , Size 57 KB, Preview Since launching Boardy Pro last week I scheduled over 12000 meetings.',
};
const ticketEp = {
  id: 't1', app: 'chrome', title: 'PROJ-128 Fix login - Jira', end: NOW, source_mix: ['uia'],
  text: 'PROJ-128 Fix login. Please complete this by friday. Status In Progress.',
};
const officeEp = { id: 'o1', app: 'excel', title: 'Q3 Budget.xlsx - Excel', end: NOW, active_duration: 120000, source_mix: ['office'], text: 'Q3 Budget.xlsx - Excel' };
const officeEp2 = { id: 'o2', app: 'excel', title: 'Q3 Budget.xlsx - Excel', end: NOW + 1000, active_duration: 60000, source_mix: ['office'], text: 'Q3 Budget.xlsx - Excel' };
const authoredMsg = { id: 'm1', app: 'teams', title: 'Chat | Microsoft Teams', end: NOW, source_mix: ['uia', 'input'], text: 'I will send the report tomorrow' };
const webEp = { id: 'w1', app: 'chrome', title: 'Some Blog', url_host: 'example.com', end: NOW, source_mix: ['ocr'], text: 'a blog post about gardening' };

// classification
ok('outlook → email', classifyKind(emailEp) === 'email');
ok('jira (title) → ticket', classifyKind(ticketEp) === 'ticket');
ok('office source → office', classifyKind(officeEp) === 'office');
ok('teams → message', classifyKind(authoredMsg) === 'message');
ok('generic web → web', classifyKind(webEp) === 'web');

// email field parse (heuristic, offline)
const er = extractRecord(emailEp);
ok('email from parsed', er.from === 'Boardy Boardman', `from=${er.from}`);
ok('email subject parsed', er.subject === 'I just broke Google Calendar', `subj=${er.subject}`);
ok('email when parsed', er.when === 'Sat', `when=${er.when}`);
ok('email body parsed', /Since launching/.test(er.body), `body=${er.body}`);
ok('received email owner=other, direction=in', er.owner === 'other' && er.direction === 'in');

// ticket parse + due reuse
const tr = extractRecord(ticketEp);
ok('ticket key parsed', tr.key === 'PROJ-128', `key=${tr.key}`);
ok('ticket due phrase parsed', tr.due === 'friday', `due=${tr.due}`);
ok('ticket dueMs computed', typeof tr.dueMs === 'number' && tr.dueMs > 0, `dueMs=${tr.dueMs}`);

// authored → owner me
ok('authored message owner=me', extractRecord(authoredMsg).owner === 'me');

// web/office not emitted as per-episode records
ok('web episode yields no record', extractRecord(webEp) === null);
ok('office episode yields no record', extractRecord(officeEp) === null);

// office aggregation (per file, dwell summed across episodes)
const agg = aggregateOffice([officeEp, officeEp2, emailEp]);
ok('office aggregated to one file', agg.length === 1 && agg[0].file === 'Q3 Budget.xlsx', JSON.stringify(agg));
ok('office dwell summed', agg[0].dwellMs === 180000 && agg[0].touches === 2, JSON.stringify(agg[0]));

// extractRecords: records exclude office/web; office array populated; LLM refine merges
const heur = await extractRecords([emailEp, ticketEp, officeEp, webEp, authoredMsg]);
ok('records exclude office + web', heur.records.length === 3 && !heur.records.some((r) => r.kind === 'office' || r.kind === 'web'), `n=${heur.records.length}`);
ok('office aggregate returned alongside', heur.office.length === 1);

const fakeLLM = async () => '{"to":"team@example.com"}';
const refined = await extractRecords([emailEp], { llm: fakeLLM });
ok('LLM refine merges missing field', refined.records[0].to === 'team@example.com', `to=${refined.records[0].to}`);

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
