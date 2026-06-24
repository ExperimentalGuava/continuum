// Stage 0 — the quality harness (#6). Capture quality is the product; this makes it measurable.
// Local + deterministic, no telemetry: runs metrics over checked-in fixtures so every later
// capture/perception change moves a number instead of a vibe. See docs/architecture/perception.md §5.
import { Pipeline } from '../pipeline.mjs';
import { Segmenter } from '../stage2/segmenter.mjs';
import { localEmbedder } from '../adapters.mjs';
import { OCR_PAIRS, SEG_FIXTURE, GROUNDING_CASES, QA_FIXTURE } from './fixtures.mjs';

// ---------- generic edit distance (works on strings or token arrays) ----------
export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
export const cer = (ref, hyp) => (ref.length ? levenshtein(ref, hyp) / ref.length : (hyp.length ? 1 : 0));
export function wer(ref, hyp) {
  const r = ref.split(/\s+/).filter(Boolean), h = hyp.split(/\s+/).filter(Boolean);
  return r.length ? levenshtein(r, h) / r.length : (h.length ? 1 : 0);
}

// ---------- set precision/recall/F1 ----------
export function prf(predSet, goldSet) {
  let tp = 0; for (const x of predSet) if (goldSet.has(x)) tp++;
  const precision = predSet.size ? tp / predSet.size : 1;
  const recall = goldSet.size ? tp / goldSet.size : 1;
  return { precision, recall, f1: (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0 };
}

// ---------- grounding: a claimed text must actually appear in its source (never fabricated) ----------
export function groundingRate(cases) {
  let ok = 0;
  for (const c of cases) if (!c.claim || c.source.includes(c.claim)) ok++;
  return cases.length ? ok / cases.length : 1;
}

// ---------- segmentation: detect new-episode boundaries by tracking segment-id changes ----------
export function segBoundaries(events, opts = {}) {
  const seg = new Segmenter({ minActiveMs: 0, minTokens: 0, ...opts });
  const owner = [];
  for (const ev of events) {
    seg.ingest(ev);
    const wid = ev.window_id || ev.app || 'unknown';
    const s = seg.open.get(wid);
    owner.push(s ? s.id : `closed@${seg.seq}`);
  }
  seg.flush();
  const b = new Set();
  for (let i = 1; i < owner.length; i++) if (owner[i] !== owner[i - 1]) b.add(i);
  return b;
}

// ---------- end-to-end: does the captured memory answer questions correctly? (top-1) ----------
export async function qaAccuracy({ embed }) {
  const p = new Pipeline({ embed, segmenterOpts: { minActiveMs: 0, minTokens: 0, idleMs: 90_000 } });
  for (const ev of QA_FIXTURE.events) await p.ingest(ev);
  await p.flush();
  let ok = 0;
  for (const q of QA_FIXTURE.queries) {
    const r = await p.search(q.q, { now: QA_FIXTURE.now });
    if (r[0] && q.expect.test(r[0].ep.text)) ok++;
  }
  return QA_FIXTURE.queries.length ? ok / QA_FIXTURE.queries.length : 1;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

// Run the full suite over the fixtures; returns a plain report object (also used by the CLI).
export async function runEval({ embed = localEmbedder() } = {}) {
  let cerSum = 0, werSum = 0;
  for (const [ref, hyp] of OCR_PAIRS) { cerSum += cer(ref, hyp); werSum += wer(ref, hyp); }
  const seg = prf(segBoundaries(SEG_FIXTURE.events), new Set(SEG_FIXTURE.boundaries));
  const g = groundingRate(GROUNDING_CASES);
  const qa = await qaAccuracy({ embed });
  return {
    ocr: { cer: r3(cerSum / OCR_PAIRS.length), wer: r3(werSum / OCR_PAIRS.length) },
    segmentation: { f1: r3(seg.f1), precision: r3(seg.precision), recall: r3(seg.recall) },
    grounding: { rate: r3(g), hallucination: r3(1 - g) },
    qa: { accuracy: r3(qa) },
  };
}

export function formatReport(r) {
  return [
    'continuum eval — capture/perception quality (local fixtures)\n',
    `  OCR fidelity        CER ${r.ocr.cer}   WER ${r.ocr.wer}        (lower is better)`,
    `  Segmentation        F1  ${r.segmentation.f1}   P ${r.segmentation.precision}  R ${r.segmentation.recall}`,
    `  Grounding           ${(r.grounding.rate * 100).toFixed(0)}% grounded   hallucination ${(r.grounding.hallucination * 100).toFixed(0)}%`,
    `  End-to-end Q&A      ${(r.qa.accuracy * 100).toFixed(0)}% top-1 correct`,
    '\n  (baselines for the current pipeline; gate capture changes on these — perception.md §6)',
  ].join('\n');
}
