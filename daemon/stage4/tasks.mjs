// Stage 4 — open-task extraction. Over captured work correspondence (email/chat/tickets),
// find commitments the user made or was asked to do, then reconcile completion so we can surface
// the ones still open. "On average correct": heuristics catch the obvious patterns for free;
// the injectable LLM is called ONLY on the hard cases (implied commitments) — the hybrid the
// product chose (local-first, frontier model for the rest). Pure + DI, so it tests offline.

import { matchesAllow, allowPatterns } from '../apps.mjs';

// --- correspondence focus (drop everything that isn't where work gets promised) ---
// Match the allowlist against app name + window title + url host, so browser-based work apps count.
function isCorrespondence(ep, allow) {
  if (ep.label?.type === 'message') return true;
  return matchesAllow(`${ep.app || ''} ${ep.title || ep.window_title || ''} ${ep.url_host || ''}`, allow);
}

const stamp = (e) => e.end ?? e.start ?? e.t ?? 0;

const STOP = new Set(
  ('the a an and or but to of for in on at by with from into is are be was were will would can could should ' +
   'i you we they it this that these those my your our their me him her them he she his as so just now then ' +
   'please thanks thank hi hello hey re fwd about before after over up out get got make made do did done')
    .split(' '),
);
const tokens = (text) => ((text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3 && !STOP.has(w));
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// --- due-date parsing (best-effort, relative to when the commitment was made) ---
const DAY = 864e5;
const endOfDay = (ms) => { const d = new Date(ms); d.setHours(23, 59, 59, 999); return d.getTime(); };
function nextDow(base, target) {
  const cur = new Date(base).getDay();
  let delta = (target - cur + 7) % 7; if (delta === 0) delta = 7;
  return endOfDay(base + delta * DAY);
}
const DOW = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
export function dueToMs(phrase, base) {
  const p = (phrase || '').toLowerCase();
  if (/today|tonight|eod|end of day/.test(p)) return endOfDay(base);
  if (/tomorrow/.test(p)) return endOfDay(base + DAY);
  if (/eow|end of week/.test(p)) return nextDow(base, 5);
  if (/next week/.test(p)) return endOfDay(base + 7 * DAY);
  for (const k in DOW) if (new RegExp(`\\b${k}\\b`).test(p)) return nextDow(base, DOW[k]);
  return null;
}
const DUE_PHRASE = /\b(today|tonight|tomorrow|eod|eow|end of day|end of week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/;
export const extractDue = (low) => (low.match(DUE_PHRASE) || [''])[0];

// --- heuristic commitment detection (free, on-device) ---
const SENT_SPLIT = /(?<=[.!?\n])\s+/;
const FIRST_PERSON = /\bi'll\b|\bi will\b|\bi can\b|\bi'm going to\b|\bi am going to\b|\blet me\b|\bi need to\b|\bi have to\b|\bi've got to\b|\bi must\b|\bi should\b|\bi gotta\b|\bi plan to\b/;
const MARKER = /\baction item\b|\btodo\b|\bto-do\b|\bfollow[- ]?up\b/;
const ASSIGNED = /\bcan you\b|\bcould you\b|\bplease\s+(review|send|update|fix|check|confirm|approve|sign off|provide|share|prepare|complete)\b|\byou (need to|should|must)\b/;
const clean = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 160);

function heuristicCommitments(ep) {
  const at = stamp(ep);
  const out = [];
  for (const raw of (ep.text || '').split(SENT_SPLIT)) {
    const s = raw.trim(); if (!s) continue;
    const low = s.toLowerCase().replace(/[’']/g, "'");
    let owner = null, conf = 0.5;
    if (FIRST_PERSON.test(low)) { owner = 'you'; conf = 0.65; }
    else if (MARKER.test(low)) { owner = 'you'; conf = 0.6; }
    else if (ASSIGNED.test(low)) { owner = 'you'; conf = 0.6; }
    if (!owner) continue;
    out.push({ text: clean(s), owner, due: extractDue(low), mentioned_at: at, source_id: ep.id, app: ep.app, confidence: conf, kind: 'heuristic' });
  }
  return out;
}

// --- LLM pass: only the hard cases (no heuristic hit) — implied/indirect commitments ---
async function llmCommitments(ep, llm) {
  const raw = await llm(
    'Extract concrete commitments/tasks the USER made or was explicitly asked to do, from this work message. ' +
      'A commitment is a future action that is not already clearly done. Return ONLY a JSON array; each item ' +
      '{"text": short imperative task, "owner": "you" or "other", "due": time phrase or "", "done": true or false}. ' +
      'Return [] if there are none. Do not invent.',
    `App: ${ep.app}\n\n${(ep.text || '').slice(0, 1500)}`, 200,
  );
  let arr = [];
  try { arr = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const at = stamp(ep);
  return arr.filter((x) => x && x.text).map((x) => ({
    text: clean(String(x.text)), owner: x.owner === 'other' ? 'other' : 'you',
    due: typeof x.due === 'string' ? x.due : '', mentioned_at: at, source_id: ep.id, app: ep.app,
    confidence: 0.7, kind: 'llm', done: x.done === true,
  }));
}

function dedupeTasks(cands) {
  const kept = [];
  for (const c of cands) {
    const ct = tokens(c.text);
    const dup = kept.find((k) => jaccard(ct, tokens(k.text)) >= 0.6);
    if (dup) { if ((c.confidence || 0) > (dup.confidence || 0)) Object.assign(dup, c); continue; }
    kept.push({ ...c });
  }
  return kept;
}

// done if the LLM said so, or a later episode shows completion language overlapping the task;
// else overdue if its due time has passed; else open. Approximate by design.
const COMPLETE = /\b(sent|done|finished|completed|complete|submitted|shipped|merged|pushed|uploaded|delivered|replied|emailed|fixed|resolved|closed|handled|wrapped up|sorted|signed off)\b/i;
function reconcileStatus(task, episodes, { now, dueMs }) {
  if (task.done) return 'done';
  const tt = tokens(task.text);
  for (const e of episodes) {
    const st = stamp(e);
    if (st <= task.mentioned_at || st > now) continue;
    if (!COMPLETE.test(e.text || '')) continue;
    if (jaccard(tt, tokens(e.text)) >= 0.15) return 'done';
  }
  if (dueMs && dueMs < now) return 'overdue';
  return 'open';
}

// Extract every commitment from the captured episodes, with a reconciled status.
export async function extractTasks(episodes, { llm, now = Date.now(), allow = allowPatterns() } = {}) {
  const comms = (episodes || []).filter((ep) => isCorrespondence(ep, allow));
  const cands = comms.flatMap(heuristicCommitments);
  if (llm) {
    const covered = new Set(cands.map((c) => c.source_id));        // local-first: LLM only on episodes
    for (const ep of comms) if (!covered.has(ep.id)) cands.push(...await llmCommitments(ep, llm)); // heuristics missed
  }
  return dedupeTasks(cands).map((t, i) => {
    const dueMs = t.due ? dueToMs(t.due, t.mentioned_at) : null;
    const status = reconcileStatus(t, episodes, { now, dueMs });
    const { kind, done, ...rest } = t;       // eslint-disable-line no-unused-vars
    return { id: `task_${i + 1}`, ...rest, dueMs, status, via: kind };
  });
}

// The digest surface: your own commitments that aren't closed (open + overdue), overdue first.
export async function openTasks(episodes, deps = {}) {
  const all = await extractTasks(episodes, deps);
  return all
    .filter((t) => t.owner === 'you' && t.status !== 'done')
    .sort((a, b) => (a.status === 'overdue' ? 0 : 1) - (b.status === 'overdue' ? 0 : 1) || (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity));
}
