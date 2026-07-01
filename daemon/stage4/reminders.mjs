// Stage 4 — the "reminding / useful" surface. Distills the capture firehose down to the handful of
// items worth surfacing: explicit reminders the user set, commitments they made or were asked to do
// (still open), and tickets with due dates. Composition over new extraction — it reuses the
// commitment+due engine (tasks.mjs) and the typed records (extract.mjs); voice-/manually-created
// reminders live in the store (store.mjs). Pure + DI, so it tests offline.
import { extractTasks } from './tasks.mjs';
import { dueToMs, extractDue } from './tasks.mjs';
import { extractRecords } from './extract.mjs';
import { loadReminders, appendReminder, loadDismissed } from '../store.mjs';

let _seq = 0;
const clean = (s, n = 160) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n);
const tokens = (t) => ((t || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length >= 3);
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Create an explicit reminder (used by the CLI and, later, the voice command). Parses a due phrase
// ("friday", "tomorrow", "eod") relative to now. id is time-based; vary by a local counter so two
// reminders added in the same ms don't collide.
export function addReminder(text, { now = Date.now() } = {}) {
  const t = clean(text, 280);
  const phrase = extractDue(t.toLowerCase());
  const dueMs = phrase ? dueToMs(phrase, now) : null;
  const r = { id: `rem_${now}_${_seq++}`, text: t, dueMs, created: now, done: false };
  appendReminder(r);
  return r;
}

const statusOf = (dueMs, now) => (dueMs && dueMs < now ? 'overdue' : 'open');

// Dedup near-identical items (the same commitment captured from email AND the ticket), keeping the
// one with a due date / higher specificity. Then rank: overdue first, then soonest due, then most
// recently surfaced.
function dedupe(items) {
  const kept = [];
  for (const it of items) {
    const tk = tokens(it.text);
    const dup = kept.find((k) => jaccard(tk, tokens(k.text)) >= 0.6);
    if (dup) { if ((it.dueMs && !dup.dueMs)) Object.assign(dup, it); continue; }
    kept.push({ ...it });
  }
  return kept;
}
function rank(items) {
  const pr = (it) => (it.status === 'overdue' ? 0 : it.dueMs ? 1 : 2);
  return items.sort((a, b) =>
    pr(a) - pr(b) ||
    (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity) ||
    (b.at ?? 0) - (a.at ?? 0));
}

// The distilled list. Buckets:
//   reminder   — explicit, user-set (voice/manual)
//   commitment — you said you'd do it (open/overdue)
//   waiting    — you asked / are owed it by someone else
//   ticket     — a ticket with a due date, not closed
export async function remindList(episodes, { llm, now = Date.now(), egress } = {}) {
  const items = [];

  for (const r of loadReminders()) {
    if (r.done) continue;
    items.push({ id: r.id, text: r.text, kind: 'reminder', owner: 'you', dueMs: r.dueMs || null, status: statusOf(r.dueMs, now), source: 'you', at: r.created });
  }

  for (const t of await extractTasks(episodes, { llm, now })) {
    if (t.status === 'done') continue;
    items.push({ id: t.id, text: t.text, kind: t.owner === 'you' ? 'commitment' : 'waiting', owner: t.owner === 'you' ? 'you' : 'other', dueMs: t.dueMs, status: t.status, source: t.app, at: t.mentioned_at });
  }

  const { records } = await extractRecords(episodes, { llm, egress });
  for (const r of records) {
    if (r.kind === 'ticket' && r.dueMs && r.status !== 'closed') {
      const ttl = r.title || '';
      const text = clean(r.key && !ttl.includes(r.key) ? `${r.key} ${ttl}` : ttl || r.key || '', 160);
      items.push({ id: r.source_id, text, kind: 'ticket', owner: 'you', dueMs: r.dueMs, status: r.status || statusOf(r.dueMs, now), source: r.app, at: r.at });
    }
  }

  const dismissed = new Set(loadDismissed());
  const keyOf = (t) => clean(t, 80).toLowerCase();
  return rank(dedupe(items)).map((it) => ({ ...it, dkey: keyOf(it.text) })).filter((it) => !dismissed.has(it.dkey));
}
