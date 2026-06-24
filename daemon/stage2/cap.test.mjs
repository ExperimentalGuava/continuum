// Episode size cap (#1) — no episode can grow unbounded from one huge frame or a fast burst.
import { Segmenter } from './segmenter.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };
const words = (e) => e.text.split(/\s+/).filter(Boolean).length;

console.log('\nEpisode size cap (#1 bloat)\n');

// a single oversized capture must not create an unbounded episode
{
  const seg = new Segmenter({ minActiveMs: 0, minTokens: 0, maxTokens: 200 });
  const huge = Array.from({ length: 5000 }, (_, i) => 'word' + i).join(' ');
  const eps = [seg.ingest({ t: 0, source: 'ocr', app: 'Terminal', window_id: 'Terminal|x', text: huge }), seg.flush()].flat();
  const maxW = Math.max(...eps.map(words));
  ok('single huge capture is hard-capped', maxW <= 210, `maxWords=${maxW}`);
}

// accumulation across captures chunks into bounded episodes (never one runaway)
{
  const seg = new Segmenter({ minActiveMs: 0, minTokens: 0, maxTokens: 120 });
  let eps = [];
  for (let i = 0; i < 12; i++) eps = eps.concat(seg.ingest({ t: i * 1000, source: 'ocr', app: 'Terminal', window_id: 'Terminal|x', text: Array.from({ length: 70 }, (_, j) => `t${i}w${j}`).join(' ') }));
  eps = eps.concat(seg.flush());
  const maxW = Math.max(...eps.map(words));
  ok('accumulation stays bounded (chunked)', maxW <= 210, `maxWords=${maxW}`);
  ok('produced multiple bounded chunks', eps.length >= 2, `episodes=${eps.length}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
