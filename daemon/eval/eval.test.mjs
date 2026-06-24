import { levenshtein, cer, wer, prf, groundingRate, segBoundaries, runEval } from './eval.mjs';
import { SEG_FIXTURE } from './fixtures.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 0 eval harness\n');

// edit-distance metrics
ok('levenshtein identical = 0', levenshtein('abc', 'abc') === 0);
ok('levenshtein one sub = 1', levenshtein('abc', 'abd') === 1);
ok('cer identical = 0', cer('hello world', 'hello world') === 0);
ok('cer one-char error', Math.abs(cer('abc', 'abd') - 1 / 3) < 1e-9, cer('abc', 'abd'));
ok('wer one-word error', Math.abs(wer('the quick brown fox', 'the quick brown dog') - 1 / 4) < 1e-9, wer('the quick brown fox', 'the quick brown dog'));

// set F1
{
  const r = prf(new Set([2]), new Set([2]));
  ok('prf exact match → F1 1', r.f1 === 1);
  const r2 = prf(new Set([1, 2]), new Set([2]));
  ok('prf partial → F1 < 1', r2.f1 < 1 && r2.f1 > 0, r2.f1);
}

// grounding / hallucination
ok('grounding detects fabrication', Math.abs(groundingRate([
  { source: 'real text here', claim: 'real text' },
  { source: 'abc', claim: 'invented' },
]) - 0.5) < 1e-9);

// segmentation boundary detection on the fixture
{
  const b = segBoundaries(SEG_FIXTURE.events);
  ok('segmentation finds the intended boundary', b.has(2), `boundaries=${[...b]}`);
}

// full suite runs and produces sane numbers
{
  const r = await runEval();
  const inUnit = (x) => x >= 0 && x <= 1;
  ok('runEval returns all sections', r.ocr && r.segmentation && r.grounding && r.qa);
  ok('grounding hallucination ~1/3 on fixtures', Math.abs(r.grounding.hallucination - 1 / 3) < 0.01, JSON.stringify(r.grounding));
  ok('metrics within [0,1]', inUnit(r.ocr.cer) && inUnit(r.segmentation.f1) && inUnit(r.qa.accuracy), JSON.stringify(r));
  ok('end-to-end Q&A answers correctly (baseline)', r.qa.accuracy >= 0.5, `qa=${r.qa.accuracy}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
