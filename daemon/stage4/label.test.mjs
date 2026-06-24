// Stage 2 — semantic labeling (#8): grounded type + owner, enums-only, confidence-gated.
import { labelEpisode, REGION_TYPES } from './distill.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 2 semantic labeling\n');

// heuristic fast-path (no LLM)
{
  const code = await labelEpisode({ app: 'Code', text: 'implementing the segmenter state machine' });
  ok('code editor → document', code.label.type === 'document', code.label.type);

  const mineTyped = await labelEpisode({ app: 'X', source_mix: ['ocr', 'input'], text: 'posting a reply on the timeline' });
  ok('focused input → owner me', mineTyped.label.owner === 'me', mineTyped.label.owner);
  ok('X with reply cues → social-post', mineTyped.label.type === 'social-post', mineTyped.label.type);

  const seen = await labelEpisode({ app: 'Safari', text: 'reading an article on a news site' });
  ok('no authorship signal → owner unknown (never guesses other)', seen.label.owner === 'unknown', seen.label.owner);
}

// LLM path (constrained, validated)
{
  const aiLLM = async () => '{"type":"ai-chat","owner":"other","conf":0.92}';
  const r = await labelEpisode({ app: 'Google Chrome', text: 'a conversation with an assistant' }, { llm: aiLLM });
  ok('LLM label applied when confident', r.label.type === 'ai-chat' && r.label.owner === 'other', JSON.stringify(r.label));

  const lowConf = async () => '{"type":"social-post","owner":"other","conf":0.2}';
  const r2 = await labelEpisode({ app: 'Google Chrome', text: 'ambiguous content' }, { llm: lowConf });
  ok('low confidence → unknown (no guess)', r2.label.type === 'unknown', JSON.stringify(r2.label));

  const garbage = async () => 'not json at all';
  const r3 = await labelEpisode({ app: 'Code', text: 'editing a file' }, { llm: garbage });
  ok('non-JSON LLM → falls back to heuristic', r3.label.type === 'document', JSON.stringify(r3.label));
}

// grounded: label carries enums + confidence only — no free text the model could fabricate
{
  const r = await labelEpisode({ app: 'Slack', text: 'team chat' }, { llm: async () => '{"type":"message","owner":"other","conf":0.8}' });
  const keys = Object.keys(r.label).sort().join(',');
  ok('label is enums + conf only (no fabricated text)', keys === 'conf,owner,type' && REGION_TYPES.includes(r.label.type), keys);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
