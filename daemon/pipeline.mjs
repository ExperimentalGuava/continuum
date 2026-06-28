// Orchestrator — wires the stages: Stage 1 events → Stage 2 segmenter → Stage 3 index
// (+ a buffer Stage 4 drains). The capture source is pluggable; the default entrypoint
// reads NDJSON CaptureEvents on stdin (what the Swift helper emits).
import { createInterface } from 'node:readline';
import { Segmenter, simhash, hamming } from './stage2/segmenter.mjs';
import { LineNovelty } from './stage2/novelty.mjs';
import { HybridIndex } from './stage3/index.mjs';
import { runDailyRollup, labelEpisode } from './stage4/distill.mjs';
import { answerQuery } from './retrieval.mjs';

export class Pipeline {
  constructor({ embed, onEpisode, segmenterOpts, novelty, sessionId } = {}) {
    this.embed = embed;
    this.seg = new Segmenter(segmenterOpts);
    this.index = new HybridIndex({ embed });
    this.episodes = [];                 // buffer for Stage 4
    this.onEpisode = onEpisode;
    this._recent = [];                  // recent episode SimHashes, for cross-episode dedup
    this.novelty = novelty === false ? null : (novelty || new LineNovelty());   // suppress repeated chrome
    this.sessionId = sessionId || null; // the activation run this pipeline belongs to (stamped on episodes)
  }

  // Capture the whole window, but drop lines already seen recently for it (stable chrome) so only
  // what changed is re-encoded. A pure-chrome refresh yields nothing novel → skipped entirely.
  async ingest(ev) {
    const e = this.novelty ? this.novelty.filter(ev) : ev;
    if (!e) return;
    for (const ep of this.seg.ingest(e)) await this._store(ep);
  }
  async flush() { for (const ep of this.seg.flush()) await this._store(ep); }

  async _store(ep) {
    // Cross-episode dedup: returning to the same screen re-captures the same text. Skip an
    // episode that's a near-duplicate of one of the last dozen (kills repeated entries).
    const sh = simhash(ep.text);
    if (this._recent.some((h) => hamming(h, sh) <= 4)) return;
    this._recent.push(sh); if (this._recent.length > 12) this._recent.shift();

    const labeled = await labelEpisode(ep, {});   // Stage 2: grounded type + owner (heuristic; cheap, no LLM)
    if (this.sessionId) labeled.session_id = this.sessionId;   // tag with the activation run (covers flush() too)
    this.episodes.push(labeled);
    await this.index.add(labeled);      // Stage 3: searchable immediately (T0)
    if (this.onEpisode) this.onEpisode(labeled);
  }

  search(query, opts) { return this.index.search(query, opts); }
  ask(query, deps) { return answerQuery(query, { index: this.index, ...deps }); }

  // Stage 4: drain the day's buffer into rollups + graph (call on idle / schedule).
  async distill(deps) {
    const eps = this.episodes; this.episodes = [];
    return runDailyRollup(eps, { embed: this.embed, ...deps });
  }
}

// Stream any NDJSON CaptureEvent source (stdin, or the capture helper's stdout) → pipeline.
export async function runReadable(input, { embed, llm, graph, onEpisode } = {}) {
  const log = (ep) => console.error(`  episode [${ep.app}] ${ep.close_reason} sal=${ep.salience} ${ep.text.slice(0, 60)}…`);
  const p = new Pipeline({ embed, onEpisode: (ep) => { log(ep); if (onEpisode) onEpisode(ep); } });
  const rl = createInterface({ input });
  for await (const line of rl) {
    const s = line.trim(); if (!s) continue;
    try { await p.ingest(JSON.parse(s)); } catch (e) { console.error('bad event:', e.message); }
  }
  await p.flush();
  if (llm) console.error('distill:', JSON.stringify(await p.distill({ llm, graphAdd: graph?.add })));
  return p;
}
export const runStdin = (deps) => runReadable(process.stdin, deps);

// node pipeline.mjs  → reads NDJSON on stdin (local-only by default).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { localEmbedder } = await import('./adapters.mjs');
  runStdin({ embed: localEmbedder() });
}
