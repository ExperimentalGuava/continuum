// Stage 5 — cross-modal fusion (#11): audio utterances bind to the active visual segment.
import { Segmenter } from './segmenter.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 5 cross-modal fusion\n');

const visual = { t: 0, source: 'ocr', app: 'Zoom', window_id: 'Zoom|Q3 review', text: 'reviewing the Q3 revenue dashboard slides with the growth chart' };
const heard = { t: 3000, source: 'audio', app: 'Zoom', window_id: 'Zoom|audio', speaker: 'them', text: 'we should cut feature X before launch' };
const mine = { t: 5000, source: 'audio', app: 'Zoom', window_id: 'Zoom|audio', speaker: 'you', text: 'agreed lets cut it and ship the dashboard first' };

// fusion ON → one multimodal episode containing both what was seen and what was heard
{
  const seg = new Segmenter({ minActiveMs: 0, minTokens: 0, fuseAudio: true });
  const eps = [seg.ingest(visual), seg.ingest(heard), seg.ingest(mine), seg.flush()].flat();
  ok('fuses into a single episode', eps.length === 1, `episodes=${eps.length}`);
  const e = eps[0];
  ok('source_mix spans both modalities', e && e.source_mix.includes('ocr') && e.source_mix.includes('audio'), JSON.stringify(e && e.source_mix));
  ok('episode holds what was seen', e && /Q3 revenue dashboard/.test(e.text));
  ok('episode holds what was heard', e && /cut feature X/.test(e.text));
  ok('speaker attribution is preserved', e && /them:/.test(e.text) && /you:/.test(e.text), e && e.text);
}

// fusion OFF (default) → unchanged behavior: audio is its own segment (back-compat)
{
  const seg = new Segmenter({ minActiveMs: 0, minTokens: 0 });
  const eps = [seg.ingest(visual), seg.ingest(heard), seg.ingest(mine), seg.flush()].flat();
  const fused = eps.some((e) => e.source_mix.includes('ocr') && e.source_mix.includes('audio'));
  ok('default keeps modalities separate (no regression)', eps.length >= 2 && !fused, `episodes=${eps.length} fused=${fused}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
