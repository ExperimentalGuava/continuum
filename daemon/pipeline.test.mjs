// End-to-end (offline): synthetic CaptureEvents → segment → index → retrieve → distill.
import { Pipeline } from './pipeline.mjs';
import { localEmbedder, mockLLM, mockGraph } from './adapters.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
const ev = (t, app, text, wid) => ({ t, source: 'ax', app, window_id: wid || app, text });

console.log('\nEnd-to-end pipeline\n');

const embed = localEmbedder();
const p = new Pipeline({ embed, segmenterOpts: { minActiveMs: 0, minTokens: 0, idleMs: 90_000 } });

// a morning: write an email, then research a different topic in the browser
await p.ingest(ev(0,      'Editor',  'composing an email to the design team about the pitch deck'));
await p.ingest(ev(20_000, 'Editor',  'composing an email to the design team about the pitch deck timeline'));
await p.ingest(ev(40_000, 'Browser', 'reading documentation about the temporal knowledge graph and entity resolution'));
await p.flush();

ok('two coherent episodes formed', p.episodes.length === 2, `got ${p.episodes.length}`);
ok('episodes are labeled (type + owner)', p.episodes.every((e) => e.label && e.label.type && e.label.owner), JSON.stringify(p.episodes.map((e) => e.label)));

const r = await p.search('what was I writing to the design team?', { now: 40_000 });
ok('retrieval surfaces the email episode', r[0].ep.app === 'Editor', `top=${r[0]?.ep.app}`);

const r2 = await p.search('knowledge graph entity resolution', { now: 40_000 });
ok('retrieval surfaces the research episode', r2[0].ep.app === 'Browser', `top=${r2[0]?.ep.app}`);

const g = mockGraph();
const a = await p.ask('design team email', { graph: g, llm: mockLLM, now: 40_000 });
ok('ask() fuses context and grounds an answer', typeof a.answer === 'string' && a.answer.length > 0, `answer=${a.answer}`);

const res = await p.distill({ llm: mockLLM, graphAdd: g.add });
ok('distill rolls up and writes to the graph', g.calls.length >= 1 && res.summarized >= 1, JSON.stringify(res));
ok('buffer drained after distill', p.episodes.length === 0);

// session stamping: every episode (incl. those emitted by flush) carries the activation run id
const ps = new Pipeline({ embed, sessionId: 'sess_test', segmenterOpts: { minActiveMs: 0, minTokens: 0, idleMs: 90_000 } });
await ps.ingest(ev(0, 'Editor', 'drafting the quarterly update for the leadership team'));
await ps.flush();   // the open segment closes via flush — must still be stamped
ok('episodes are stamped with session_id (covers flush)', ps.episodes.length >= 1 && ps.episodes.every((e) => e.session_id === 'sess_test'), JSON.stringify(ps.episodes.map((e) => e.session_id)));

const pn = new Pipeline({ embed, segmenterOpts: { minActiveMs: 0, minTokens: 0, idleMs: 90_000 } });
await pn.ingest(ev(0, 'Editor', 'a note with no active session attached at all'));
await pn.flush();
ok('no sessionId → episodes carry none (legacy bucket)', pn.episodes.every((e) => e.session_id === undefined), JSON.stringify(pn.episodes.map((e) => e.session_id)));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
