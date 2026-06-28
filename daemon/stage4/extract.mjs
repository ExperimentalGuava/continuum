// Stage 4 — typed records. Turn captured episodes into structured, per-type content the agent (and
// the digest/dashboard) can absorb without re-reading raw blobs: email (who/when/what), messages,
// tickets (title/due/status), Office activity aggregates, and 3rd-party actions.
//
// Hybrid + DI (mirrors tasks.mjs): heuristics parse the obvious shape for free, on-device; the
// injectable LLM refines who/when/what only when configured (the optional, only off-device pass).
// Reuses the app classifier (apps.mjs) and the due-date parser (tasks.mjs) — no new primitives.
import { classOf } from '../apps.mjs';
import { dueToMs, extractDue } from './tasks.mjs';

const clean = (s, n = 160) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n);
const firstLine = (t) => (String(t || '').split(/[\n\r]/)[0] || '').trim();
const atOf = (ep) => ep.end ?? ep.start ?? ep.t ?? 0;

// owner = me when there's a positive authoring signal (the user typed here, or authored text was
// extracted); otherwise other. Mirrors heuristicOwner in distill.mjs, but resolves to other (not
// unknown) because a captured email/message you didn't author is, by definition, someone else's.
const ownerOf = (ep) => ((ep.source_mix || []).includes('input') || ep.structured?.authored ? 'me' : 'other');

// Route an episode to a content kind. Office is detected by the daemon's `office` source first (so a
// Word doc that merely mentions "Salesforce" isn't mis-bucketed), then by app/title/url-host class.
export function classifyKind(ep) {
  if ((ep.source_mix || []).includes('office')) return 'office';
  const hay = `${ep.app || ''} ${ep.title || ''} ${ep.url_host || ''}`;
  const cls = classOf(hay);
  if (cls === 'office') return 'office';
  if (cls === 'outlook') return 'email';
  if (cls === 'teams' || cls === 'slack') return 'message';
  if (cls === 'atlassian' || cls === 'servicenow' || cls === 'salesforce') return 'ticket';
  if (cls === 'anaplan') return 'action';            // best-effort (Phase 4)
  if (ep.label?.type === 'message') return 'message';
  if (ep.url_host) return 'web';
  return 'other';
}

// --- heuristic field parsers (baseline, fully offline) ---
function parseEmail(text) {
  const t = text || '';
  const from = (t.match(/\bFrom[:\s]+(.+?)(?:,\s*(?:Subject|Sent|Received|To)\b|[\n\r])/i) || [])[1];
  const subject = (t.match(/\bSubject[:\s]+(.+?)(?:,\s*(?:Received|Sent|Size|To|From)\b|[\n\r])/i) || [])[1];
  const when = (t.match(/\b(?:Received|Sent)[:\s]+(.+?)(?:,\s*(?:Size|Subject|To|From)\b|[\n\r])/i) || [])[1];
  const body = (t.match(/\bPreview[:\s]+([\s\S]+)$/i) || [])[1];
  return { from: clean(from), subject: clean(subject), when: clean(when), body: clean(body, 600) };
}
function parseTicket(ep) {
  const t = ep.text || '';
  const key = (`${ep.title || ''} ${t}`.match(/\b[A-Z][A-Z0-9]+-\d+\b/) || [])[0] || null;
  const duePhrase = extractDue(t.toLowerCase());
  const dueMs = duePhrase ? dueToMs(duePhrase, atOf(ep)) : null;
  let status = 'open';
  if (/\b(closed|resolved|done|completed)\b/i.test(t)) status = 'closed';
  else if (dueMs && dueMs < Date.now()) status = 'overdue';
  return { key, title: clean(ep.title || firstLine(t), 160), due: duePhrase || '', dueMs, status, body: clean(t, 600) };
}

// One typed record from one episode (heuristic only). null for kinds we don't emit per-episode.
export function extractRecord(ep) {
  const kind = classifyKind(ep);
  if (kind === 'office' || kind === 'other' || kind === 'web') return null;  // office → aggregate; web/other skipped
  const base = { kind, app: ep.app || '', at: atOf(ep), source_id: ep.id, owner: ownerOf(ep), summary: ep.structured?.summary || '' };
  if (kind === 'email') return { ...base, ...parseEmail(ep.text), direction: base.owner === 'me' ? 'out' : 'in' };
  if (kind === 'message') return { ...base, from: base.owner === 'me' ? 'me' : '', to: '', when: '', text: clean(ep.text, 600) };
  if (kind === 'ticket') return { ...base, ...parseTicket(ep) };
  if (kind === 'action') return { ...base, what: clean(ep.title || ep.text, 160), url_host: ep.url_host || null };
  return base;
}

// LLM refine: fill who/when/what the heuristic missed. Grounded JSON only; merges non-empty over the
// heuristic baseline. Called only for email/message/ticket and only when an llm is configured.
async function refineRecord(ep, rec, llm) {
  const shape = rec.kind === 'email' ? '{"from":"","to":"","when":"","subject":"","body":""}'
    : rec.kind === 'ticket' ? '{"key":"","title":"","due":"","status":"","body":""}'
    : '{"from":"","to":"","when":"","text":""}';
  const raw = await llm(
    `Extract structured fields from this captured ${rec.kind}. Return ONLY JSON ${shape}. Use "" when absent; do not invent.`,
    `App: ${ep.app}\n\n${(ep.text || '').slice(0, 1500)}`, 220,
  );
  let p = {};
  try { p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { return rec; }
  const out = { ...rec };
  for (const k of Object.keys(p)) {
    if (typeof p[k] === 'string' && p[k].trim()) out[k] = clean(p[k], k === 'body' || k === 'text' ? 600 : 160);
  }
  if (rec.kind === 'ticket' && out.due) out.dueMs = dueToMs(out.due.toLowerCase(), rec.at) ?? rec.dueMs ?? null;
  if (rec.kind === 'email') out.direction = out.owner === 'me' ? 'out' : 'in';
  return out;
}

// Per-file Office activity aggregate (file name + dwell + touches) — no document body.
export function aggregateOffice(episodes) {
  const officeFile = (title) => (title || '').replace(/\s+[-–]\s+(Word|Excel|PowerPoint)\b.*$/i, '').trim() || (title || '').trim();
  const byFile = new Map();
  for (const ep of episodes || []) {
    if (classifyKind(ep) !== 'office') continue;
    const file = officeFile(ep.title || ep.text || '');
    if (!file) continue;
    const g = byFile.get(file) || { file, app: ep.app || '', dwellMs: 0, touches: 0, last: 0 };
    g.dwellMs += ep.active_duration || 0;
    g.touches += 1;
    g.last = Math.max(g.last, atOf(ep));
    byFile.set(file, g);
  }
  return [...byFile.values()].sort((a, b) => b.dwellMs - a.dwellMs);
}

// Turn episodes into typed records + the Office aggregate. LLM optional (refines email/message/ticket).
export async function extractRecords(episodes, { llm } = {}) {
  const records = [];
  for (const ep of episodes || []) {
    let rec = extractRecord(ep);
    if (!rec) continue;
    if (llm && (rec.kind === 'email' || rec.kind === 'message' || rec.kind === 'ticket')) rec = await refineRecord(ep, rec, llm);
    records.push(rec);
  }
  return { records, office: aggregateOffice(episodes) };
}
