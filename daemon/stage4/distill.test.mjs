import { runDailyRollup, cluster, structureEpisode } from './distill.mjs';
import { localEmbedder, mockLLM, mockGraph } from '../adapters.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
const embed = localEmbedder();

console.log('\nStage 4 distillation\n');

const eps = [
  { text: 'graph extraction entity resolution temporal edges in the knowledge graph', salience: 0.90 },
  { text: 'graph extraction temporal edges invalidation in the knowledge graph', salience: 0.85 },  // merges with ^
  { text: 'lunch coffee campus walk short break', salience: 0.20 },
  { text: 'segmenter dedup simhash boundaries idle drift state machine', salience: 0.95 },
  { text: 'pitch deck design slides for investors and demo', salience: 0.60 },
];

// clustering merges the two near-topic episodes
{
  const items = await Promise.all(eps.map(async (e) => ({ e, vec: await embed(e.text), salience: e.salience })));
  const cs = cluster(items);
  ok('clustering merges related episodes', cs.length < eps.length, `clusters=${cs.length}`);
}

// budget-bounded escalation, salience-first, graph-extract the summaries
{
  const g = mockGraph();
  const res = await runDailyRollup(eps, { embed, llm: mockLLM, graphAdd: g.add, dailyBudget: 2 });
  ok('LLM budget respected', res.summarized === 2 && res.llmCalls === 2, JSON.stringify(res));
  ok('the rest deferred (still searchable at T0)', res.deferred === res.clusters - 2 && res.deferred > 0, `deferred=${res.deferred}`);
  ok('graph writes == summaries (T3 on distilled apex)', res.graphWrites === 2 && g.calls.length === 2);
  ok('highest-salience cluster summarized first', res.summaries[0].salience >= res.summaries[1].salience, `${res.summaries.map(s => s.salience)}`);
}

// #2 — LLM structuring pass
{
  const jsonLLM = async () => '{"summary":"replying on X","authored":"thanks for the support!","app":"Google Chrome"}';
  const s = await structureEpisode({ app: 'Google Chrome', text: 'X Home ... thanks for the support! ... Trending ...' }, { llm: jsonLLM });
  ok('structureEpisode extracts the user-authored text', s.structured.authored === 'thanks for the support!');
  ok('structureEpisode sets a summary', s.structured.summary.length > 0);
  const passthrough = await structureEpisode({ app: 'X', text: 'hi' }, { llm: null });
  ok('no llm → passthrough (no structured field)', passthrough.structured === undefined);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
