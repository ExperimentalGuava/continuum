// Stage 4 — distillation. The only place an LLM runs: async, batched, budget-bounded,
// over distilled input (topic clusters / rollups), never raw episodes.
import { cosine, mean } from '../util.mjs';

// Greedy single-pass clustering by embedding cosine. Cheap, no LLM.
export function cluster(items, simThreshold = 0.45) {
  const clusters = [];
  for (const it of items) {
    let best = null, bs = simThreshold;
    for (const c of clusters) { const s = cosine(it.vec, c.centroid); if (s > bs) { bs = s; best = c; } }
    if (best) { best.items.push(it); best.centroid = mean(best.items.map((x) => x.vec)); }
    else clusters.push({ items: [it], centroid: it.vec });
  }
  return clusters;
}

const clusterSalience = (c) => Math.max(...c.items.map((x) => x.salience ?? 0.5));

// Daily rollup: cluster the day's episodes, summarize the most salient clusters within
// a fixed LLM budget (the escalation ladder's T2), then graph-extract the summaries (T3).
export async function runDailyRollup(episodes, { embed, llm, graphAdd, group = 'default', date, dailyBudget = 15 } = {}) {
  const items = await Promise.all(episodes.map(async (e) => ({ e, vec: await embed(e.text), salience: e.salience ?? 0.5 })));
  const clusters = cluster(items).sort((a, b) => clusterSalience(b) - clusterSalience(a));

  const summaries = [];
  let llmCalls = 0;
  for (const c of clusters) {
    if (llmCalls >= dailyBudget) break;                          // budget gate → tail stays at T0 (embedded only)
    const body = c.items.map((x) => x.e.text).join('\n---\n');
    const summary = await llm('Summarize this cluster of one day\'s activity into durable facts and open loops.', body, 300);
    llmCalls++;
    summaries.push({ summary, salience: clusterSalience(c), size: c.items.length });
  }

  let graphWrites = 0;                                           // T3: graph-extract the distilled summaries
  for (const s of summaries) { if (graphAdd) { await graphAdd(s.summary, group, date); graphWrites++; } }

  return {
    clusters: clusters.length,
    summarized: summaries.length,
    deferred: clusters.length - summaries.length,                // dropped to budget → still searchable via Stage 3
    llmCalls, graphWrites, summaries,
  };
}

// Higher rollups compose summaries-of-summaries (weekly from dailies, monthly from weeklies).
export async function rollupOver(summaries, { llm, period = 'week' }) {
  const body = summaries.map((s) => (s.summary ?? s)).join('\n');
  return llm(`Synthesize this ${period} from the daily summaries: themes, progress, recurring people/projects, trajectory.`, body, 500);
}

// Issue #2 — turn a raw (noisy OCR) episode into structured fields with the injectable LLM.
// Semantic, so it generalizes across UI redesigns (vs brittle per-site parsers). Optional;
// returns the episode unchanged if no LLM is configured.
export async function structureEpisode(ep, { llm } = {}) {
  if (!llm) return ep;
  const raw = await llm(
    'Clean a raw screen capture into JSON. Return ONLY: {"summary": one sentence on what the user was doing, "authored": text the USER themselves wrote/typed (else ""), "app": the app}. Exclude UI chrome and other people\'s content from "authored".',
    `App: ${ep.app}\n\n${ep.text}`, 300,
  );
  let parsed = {};
  try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { /* model returned non-JSON */ }
  return { ...ep, structured: { summary: parsed.summary || '', authored: parsed.authored || '', app: parsed.app || ep.app } };
}
