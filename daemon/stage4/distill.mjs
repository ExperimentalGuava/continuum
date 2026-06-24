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

// Stage 2 (#8) — semantic labeling: what a region IS (type) and WHO authored it (owner), the way a
// person reads a screen. Labels are a closed enum + confidence (never free text), so the model can
// organize but cannot fabricate content. Below a confidence floor we emit `unknown` over a guess.
export const REGION_TYPES = ['document', 'ai-chat', 'message', 'social-post', 'comment', 'composer', 'nav', 'toolbar', 'ad', 'result', 'unknown'];
export const REGION_OWNERS = ['me', 'other', 'system', 'unknown'];

function heuristicType(ep) {
  const app = (ep.app || '').toLowerCase(), t = (ep.text || '').toLowerCase();
  if (/(claude|chatgpt|gemini|copilot|perplexity)/.test(app) || /\b(chatgpt|claude|ai assistant)\b/.test(t)) return 'ai-chat';
  if (/(code|xcode|vim|emacs|terminal|iterm|jetbrains|intellij|pycharm|sublime|zed)/.test(app)) return 'document';
  if (/(word|docs|notion|obsidian|pages|notes|bear|craft)/.test(app)) return 'document';
  if (/(mail|gmail|outlook|slack|discord|messages|whatsapp|telegram|teams)/.test(app)) return 'message';
  if (app === 'x' || /\b(twitter|reddit|linkedin|facebook|instagram|threads|mastodon)\b/.test(app) || /\b(repost|retweet|upvote)\b/.test(t)) return 'social-post';
  return 'unknown';
}
// We only assert ownership from a positive signal (focused input / extracted authored text); absence
// of a signal is `unknown`, never an assumed "other".
function heuristicOwner(ep) {
  if ((ep.source_mix || []).includes('input')) return 'me';
  if (ep.structured && ep.structured.authored) return 'me';
  return 'unknown';
}

export async function labelEpisode(ep, { llm, minConf = 0.4 } = {}) {
  const hType = heuristicType(ep), hOwner = heuristicOwner(ep);
  const heur = { type: hType, owner: hOwner, conf: { type: hType === 'unknown' ? 0.3 : 0.6, owner: hOwner === 'unknown' ? 0.3 : 0.8 } };
  if (!llm) return { ...ep, label: heur };
  const raw = await llm(
    'Classify this captured screen region. Return ONLY JSON {"type": one of [document,ai-chat,message,social-post,comment,composer,nav,toolbar,ad,result,unknown], "owner": one of [me,other,system,unknown] (me = the user authored it themselves), "conf": number 0..1}. Use "unknown" when unsure. Do NOT invent or quote content.',
    `App: ${ep.app}\n\n${(ep.text || '').slice(0, 1500)}`, 120,
  );
  let p = {};
  try { p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { /* non-JSON → heuristic */ }
  const type = REGION_TYPES.includes(p.type) ? p.type : heur.type;
  const owner = REGION_OWNERS.includes(p.owner) ? p.owner : heur.owner;
  const conf = typeof p.conf === 'number' ? Math.max(0, Math.min(1, p.conf)) : 0.5;
  return { ...ep, label: { type: conf < minConf ? 'unknown' : type, owner, conf: { type: conf, owner: heur.conf.owner } } };
}
