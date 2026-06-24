// Stage 2 — dedup + segmentation engine (pure core, no I/O).
//
// Consumes a stream of normalized CaptureEvents and emits coherent Episodes.
// Source-agnostic: an event looks the same whether it came from the event-driven
// AX/NSWorkspace/FSEvents capture helper (Stage 1) or any other producer.
//
//   CaptureEvent { t:ms, source:'ax'|'ocr'|'clipboard'|'file'|'audio',
//                  app, window_id, url_host?, title?, text, secure?, speaker? }
//   Episode      { id, app, window_id, url_host, title, start, end,
//                  active_duration, text, source_mix[], dedup_count,
//                  content_hash, salience, close_reason }
//
// Design notes:
//  - Per-window accumulators (Map keyed by window_id) handle split attention, and
//    naturally debounce alt-tab thrashing: a 2s detour to another window doesn't
//    shatter the original segment — it stays open until its own idle gap elapses.
//  - Dedup is a cheap-first cascade (exact hash → SimHash near-dup) and *coalesces*
//    rather than drops, so a burst of keystroke events becomes one evolving state.
//  - The drift similarity function is injectable; the default is a dependency-free
//    bag-of-words cosine. Production injects an embedding-based similarity.

// ---------- tokenization ----------
const WORD = /[a-z0-9]+/gi;
const tokens = (s) => (s.toLowerCase().match(WORD) || []);
const shingles = (s) => { const t = tokens(s); if (t.length < 2) return t; const g = []; for (let i = 0; i < t.length - 1; i++) g.push(t[i] + ' ' + t[i + 1]); return g; };

// ---------- 64-bit SimHash (FNV-1a) for near-duplicate detection ----------
const MASK64 = 0xffffffffffffffffn;
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) { h ^= BigInt(str.charCodeAt(i)); h = (h * 0x100000001b3n) & MASK64; }
  return h;
}
export function simhash(text) {
  const grams = shingles(text);
  if (!grams.length) return 0n;
  const bits = new Array(64).fill(0);
  for (const g of grams) { const h = fnv1a64(g); for (let i = 0; i < 64; i++) bits[i] += ((h >> BigInt(i)) & 1n) === 1n ? 1 : -1; }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (bits[i] > 0) out |= (1n << BigInt(i));
  return out;
}
export function hamming(a, b) { let x = a ^ b, c = 0; while (x) { c += Number(x & 1n); x >>= 1n; } return c; }
const contentHash = (text) => fnv1a64(text).toString(16).padStart(16, '0');

// ---------- bag-of-words cosine (default drift similarity) ----------
function bow(text) { const m = new Map(); for (const t of tokens(text)) m.set(t, (m.get(t) || 0) + 1); return m; }
export function cosine(a, b) {
  const A = bow(a), B = bow(b);
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of A) { na += v * v; if (B.has(k)) dot += v * B.get(k); }
  for (const [, v] of B) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ---------- normalization + PII redaction (the privacy boundary) ----------
const CLOCK = /\b\d{1,2}:\d{2}(:\d{2})?\s?([ap]\.?m\.?)?\b/gi;       // volatile clock tokens
const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const LONGNUM = /\b(?:\d[ -]?){11,}\b/g;                            // cards / SSNs / phone-ish
export function normalize(text) { return (text || '').replace(CLOCK, ' ').replace(/\s+/g, ' ').trim(); }
export function redactPII(text) { return text.replace(EMAIL, '[email]').replace(LONGNUM, '[number]'); }

// ---------- app-class salience weight ----------
function appWeight(app = '') {
  const a = app.toLowerCase();
  if (/(code|xcode|vim|emacs|terminal|iterm|jetbrains|intellij|pycharm)/.test(a)) return 0.9;
  if (/(word|docs|notion|obsidian|pages|notes|mail|gmail|outlook)/.test(a)) return 0.85;
  if (/(chrome|safari|firefox|arc|edge)/.test(a)) return 0.6;
  if (/(slack|discord|messages|whatsapp|telegram|teams)/.test(a)) return 0.45;
  if (/(music|spotify|youtube|netflix|tv|vlc|quicktime)/.test(a)) return 0.15;
  return 0.5;
}

const DEFAULTS = {
  idleMs: 90_000,            // gap that closes a segment
  driftSimMin: 0.35,         // below this similarity = topic boundary
  simhashNear: 3,            // Hamming <= this = near-duplicate → coalesce
  minActiveMs: 5_000,        // below this AND minTokens → drop on close
  minTokens: 8,
  maxMs: 20 * 60_000,        // force-close (chunk) a long segment
  maxTokens: 4_000,
  activeGapCapMs: 30_000,    // cap per-gap active-time accrual
  sim: cosine,               // injectable similarity (swap in embeddings in prod)
  fuseAudio: false,          // cross-modal fusion (#11): merge audio utterances into the active visual segment
};

export class Segmenter {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.open = new Map();   // window_id -> open segment
    this.seq = 0;
    this.dropped = 0;        // segments discarded as too-trivial (observability)
  }

  // Ingest one event; returns the array of Episodes closed as a result.
  ingest(ev) {
    const out = [];
    if (!ev || ev.secure) return out;                          // never capture secure fields
    const text = redactPII(normalize(ev.text));
    if (!text) return out;
    const t = ev.t;

    // 1) idle sweep — close any window whose last activity is older than idleMs
    for (const [wid, seg] of this.open) {
      if (t - seg.lastActive > this.cfg.idleMs) { const e = this._close(seg, 'idle'); if (e) out.push(e); this.open.delete(wid); }
    }

    // cross-modal fusion (#11): a spoken utterance attaches to the active visual segment of the
    // same app at this timestamp — so a meeting's slides-seen + words-heard become ONE episode
    // (the perceptual "unity assumption": signals co-occurring in time bind into one event).
    if (this.cfg.fuseAudio && ev.source === 'audio') {
      let host = null;
      for (const [, s] of this.open) if (s.app === ev.app && (!host || s.lastActive > host.lastActive)) host = s;
      if (host) {
        this._accrue(host, t);
        const line = (ev.speaker ? ev.speaker + ': ' : '') + text;
        host.text += ' ' + line; host.lastText = line; host.simhash = simhash(line);
        host.tokens += tokens(line).length; host.updateCount++; host.sourceMix.add('audio');
        return out;
      }
      // no active visual segment → fall through; the utterance forms its own segment
    }

    const wid = ev.window_id || ev.app || 'unknown';
    let seg = this.open.get(wid);
    if (!seg) { this.open.set(wid, this._new(ev, text, t)); return out; }

    // 2) dedup cascade — near-duplicate? coalesce, don't branch
    const sh = simhash(text);
    if (text === seg.lastText || hamming(sh, seg.simhash) <= this.cfg.simhashNear) {
      this._accrue(seg, t);
      seg.dedupCount++;
      if (text.length > seg.lastText.length) { seg.lastText = text; seg.simhash = sh; }  // keep fullest state
      return out;
    }

    // 3) topic drift within the same window?
    if (seg.tokens >= this.cfg.minTokens && this.cfg.sim(text, seg.text) < this.cfg.driftSimMin) {
      const e = this._close(seg, 'drift'); if (e) out.push(e);
      this.open.set(wid, this._new(ev, text, t));
      return out;
    }

    // 4) size cap → chunk
    if (t - seg.start > this.cfg.maxMs || seg.tokens > this.cfg.maxTokens) {
      const e = this._close(seg, 'maxsize'); if (e) out.push(e);
      this.open.set(wid, this._new(ev, text, t));
      return out;
    }

    // 5) related content in the same window → append + coalesce
    this._accrue(seg, t);
    seg.text += ' ' + text;
    seg.lastText = text;
    seg.simhash = sh;
    seg.tokens += tokens(text).length;
    seg.updateCount++;
    seg.sourceMix.add(ev.source);
    return out;
  }

  // Drain all open segments (call at end-of-stream or on shutdown).
  flush() { const out = []; for (const [, seg] of this.open) { const e = this._close(seg, 'flush'); if (e) out.push(e); } this.open.clear(); return out; }

  _new(ev, text, t) {
    return {
      id: `seg_${++this.seq}`, app: ev.app || '', window_id: ev.window_id || ev.app || 'unknown',
      url_host: ev.url_host || null, title: ev.title || null,
      start: t, lastActive: t, activeMs: 0,
      text, lastText: text, simhash: simhash(text), tokens: tokens(text).length,
      updateCount: 1, dedupCount: 0, sourceMix: new Set([ev.source]),
    };
  }

  _accrue(seg, t) { seg.activeMs += Math.min(Math.max(0, t - seg.lastActive), this.cfg.activeGapCapMs); seg.lastActive = t; }

  _close(seg, reason) {
    // drop trivial segments (alt-tab detours, stray clicks)
    if (seg.activeMs < this.cfg.minActiveMs && seg.tokens < this.cfg.minTokens) { this.dropped++; return null; }
    const dwell = Math.min(seg.activeMs / (10 * 60_000), 1);
    const input = Math.min(seg.updateCount / 20, 1);
    const salience = Math.round((0.4 * dwell + 0.3 * input + 0.3 * appWeight(seg.app)) * 100) / 100;
    return {
      id: seg.id, app: seg.app, window_id: seg.window_id, url_host: seg.url_host, title: seg.title,
      start: seg.start, end: seg.lastActive, active_duration: seg.activeMs,
      text: seg.text, source_mix: [...seg.sourceMix], dedup_count: seg.dedupCount,
      content_hash: contentHash(seg.text), salience, close_reason: reason,
    };
  }
}
