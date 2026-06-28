// Tests for the Stage 2 segmenter. Run: node daemon/stage2/segmenter.test.mjs
import { Segmenter, simhash, hamming, cosine, redactPII } from './segmenter.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  ${extra}`); } };
const ev = (t, app, text, o = {}) => ({ t, source: o.source || 'ax', app, window_id: o.window_id || app, text, ...o });

// run a whole stream and collect every episode (ingest-closed + flushed)
function run(seg, events) { const out = []; for (const e of events) out.push(...seg.ingest(e)); out.push(...seg.flush()); return out; }

console.log('\nStage 2 segmenter\n');

// 1) near-duplicate burst coalesces into ONE evolving segment
{
  const s = new Segmenter({ minActiveMs: 0, minTokens: 0 });
  // same field re-captured (AX value-changed re-fires) — punctuation/whitespace only
  const eps = run(s, [
    ev(0,     'Editor', 'composing an email to the design team about the deck'),
    ev(400,   'Editor', 'composing an email to the design team about the deck.'),   // simhash-near
    ev(900,   'Editor', 'composing an email to the design team about the deck,'),   // simhash-near
  ]);
  ok('near-dup burst → 1 episode', eps.length === 1, `got ${eps.length}`);
  ok('dedup_count records the coalesced events', eps[0]?.dedup_count >= 2, `got ${eps[0]?.dedup_count}`);
}

// 2) alt-tab detour: brief visit to another window is dropped, original survives intact
{
  const s = new Segmenter({ idleMs: 90_000, minActiveMs: 5_000, minTokens: 8 });
  const eps = run(s, [
    ev(0,      'Editor', 'working on the quarterly planning document with budgets and timelines'),
    ev(10_000, 'Editor', 'working on the quarterly planning document adding the staffing section'),
    ev(15_000, 'Spotify', 'skip track'),                         // 2s detour, tiny
    ev(17_000, 'Editor', 'working on the quarterly planning document finalizing the staffing plan'),
  ]);
  const apps = eps.map(e => e.app);
  ok('alt-tab detour does not shatter the editor segment', apps.filter(a => a === 'Editor').length === 1, `editor segs: ${apps.filter(a => a === 'Editor').length}`);
  ok('trivial Spotify detour dropped', !apps.includes('Spotify'), `apps: ${apps}`);
  ok('detour drop counted', s.dropped === 1, `dropped=${s.dropped}`);
}

// 3) idle gap closes a segment
{
  const s = new Segmenter({ idleMs: 1_000, minActiveMs: 0, minTokens: 0 });
  const eps = run(s, [
    ev(0,     'Editor', 'reading the architecture notes about ingestion'),
    ev(500,   'Editor', 'reading the architecture notes about the funnel'),
    ev(5_000, 'Editor', 'reading the architecture notes about segmentation'),  // gap 4500 > idle
  ]);
  ok('idle gap → 2 episodes', eps.length === 2, `got ${eps.length}`);
  ok('first closed with reason=idle', eps[0]?.close_reason === 'idle', `got ${eps[0]?.close_reason}`);
}

// 4) topic drift inside the same window splits
{
  const s = new Segmenter({ minActiveMs: 0, minTokens: 4, simhashNear: 0 });
  const eps = run(s, [
    ev(0,    'Browser', 'the quick brown fox jumps over the lazy dog repeatedly today'),
    ev(2000, 'Browser', 'completely unrelated banana airplane volcano tax refund paperwork'),
  ]);
  ok('topic drift → 2 episodes', eps.length === 2, `got ${eps.length}`);
  ok('split closed with reason=drift', eps[0]?.close_reason === 'drift', `got ${eps[0]?.close_reason}`);
}

// 5) size cap chunks a run-on segment (isolate: disable near-dup + drift)
{
  const s = new Segmenter({ maxTokens: 5, minActiveMs: 0, minTokens: 0, simhashNear: -1, driftSimMin: 0 });
  const eps = run(s, [
    ev(0,    'Code', 'alpha beta gamma'),
    ev(1000, 'Code', 'delta epsilon zeta eta'),   // pushes tokens over 5
    ev(2000, 'Code', 'theta iota kappa'),
  ]);
  ok('maxTokens chunks the segment', eps.length >= 2, `got ${eps.length}`);
  ok('chunk closed with reason=maxsize', eps.some(e => e.close_reason === 'maxsize'), `reasons: ${eps.map(e => e.close_reason)}`);
}

// 6) secure fields are never captured
{
  const s = new Segmenter({ minActiveMs: 0, minTokens: 0 });
  const eps = run(s, [
    ev(0, 'Browser', 'hunter2 supersecret', { secure: true }),
    ev(1, 'Browser', 'reading a public blog post about typescript'),
  ]);
  ok('secure event ignored', eps.length === 1 && !eps[0].text.includes('hunter2'), `text: ${eps[0]?.text}`);
}

// 7) PII redaction happens before emit
{
  const s = new Segmenter({ minActiveMs: 0, minTokens: 0 });
  const eps = run(s, [ev(0, 'Mail', 'ping me at nikhil@umass.edu or call 4155551234567')]);
  ok('email redacted', eps[0]?.text.includes('[email]') && !eps[0].text.includes('umass.edu'), `text: ${eps[0]?.text}`);
  ok('long number redacted', eps[0]?.text.includes('[number]'), `text: ${eps[0]?.text}`);
}

// 8) salience: a long, typed code session outranks a passive video glance
{
  const s = new Segmenter({ minActiveMs: 0, minTokens: 0 });
  const code = run(new Segmenter({ minActiveMs: 0, minTokens: 0 }), Array.from({ length: 12 }, (_, i) =>
    ev(i * 20_000, 'Code', `implementing the segmenter feature number ${i} with tests and edge cases`)));
  const video = run(new Segmenter({ minActiveMs: 0, minTokens: 0 }), [ev(0, 'YouTube', 'watching a trailer')]);
  ok('code session more salient than passive video', code[0].salience > video[0].salience, `code=${code[0].salience} video=${video[0].salience}`);
}

// 9) unit: simhash near for tiny edits, far for different text
{
  const a = simhash('the design partner pipeline for continuum');
  const b = simhash('the design partner pipeline for continuum!');
  const c = simhash('totally different content about weather and sports');
  ok('simhash: tiny edit is near', hamming(a, b) <= 3, `dist=${hamming(a, b)}`);
  ok('simhash: different text is far', hamming(a, c) > 3, `dist=${hamming(a, c)}`);
  ok('cosine: identical=1', Math.abs(cosine('a b c', 'a b c') - 1) < 1e-9);
  ok('redactPII pure helper', redactPII('x@y.com') === '[email]');
}

// 10) authored flag → source_mix includes 'input' (the owner=me signal the daemon now emits)
{
  const s = new Segmenter({ minActiveMs: 0, minTokens: 0 });
  const eps = run(s, [ev(0, 'Teams', 'I will send the report tomorrow', { authored: true })]);
  ok('authored event tags source_mix with input', eps[0]?.source_mix.includes('input'), `mix=${eps[0]?.source_mix}`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
