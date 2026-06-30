// Run with an isolated data dir:  CONTINUUM_DATA=$(mktemp -d) node daemon/stage4/voice.test.mjs
import { parseIntent, isCommand, stripWake, runCommand } from './voice.mjs';
import { loadReminders, loadDrafts } from '../store.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 4 voice command (intent → action)\n');

// wake-word routing
ok('isCommand detects the wake word', isCommand('Continuum, remind me to call Sam') && !isCommand('I should remind myself later'));
ok('stripWake removes the prefix', stripWake('Hey Continuum, draft an email') === 'draft an email');

// intent parsing (heuristic, no model)
ok('parses a reminder', parseIntent('Continuum remind me to send the report friday').action === 'reminder');
const d = parseIntent('Continuum draft an email to Sarah about the Q3 deck');
ok('parses a draft with recipient + topic', d.action === 'draft' && d.to === 'Sarah' && /Q3 deck/.test(d.instruction), JSON.stringify(d));
ok('non-command → none', parseIntent('what time is the standup').action === 'none');

// runCommand: reminder → persisted to the reminders store (also surfaces in `continuum remind`)
const r = await runCommand('Continuum, remind me to renew the cert tomorrow');
ok('reminder command persists a reminder', r.ok && r.action === 'reminder' && loadReminders().some((x) => /renew the cert/.test(x.text)), r.message);

// runCommand: draft with NO llm → template (offline path still works, RAM-free)
const t = await runCommand('Continuum draft an email to Alex about the budget review');
ok('draft (no llm) produces a template draft', t.ok && t.action === 'draft' && /budget review/.test(t.draft.body), JSON.stringify(t.draft));
ok('draft is persisted', loadDrafts().some((x) => /budget review/.test(x.body)));

// runCommand: draft WITH a mock llm → uses the composed JSON
const fakeLLM = async () => '{"to":"alex@firm.com","subject":"Budget review","body":"Hi Alex, here is the budget review summary."}';
const tl = await runCommand('Continuum draft an email to Alex about the budget', { llm: fakeLLM });
ok('draft (llm) uses the composed fields', tl.draft.subject === 'Budget review' && /summary/.test(tl.draft.body), JSON.stringify(tl.draft));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
