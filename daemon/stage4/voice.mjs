// Stage 4 — voice command intent → action. Turns a recognized command transcript into an action:
// set a reminder, or draft an email. Heuristic-first (no resident model — the common path is pure
// regex), with the injectable LLM used ONLY to compose a draft, on-demand and transient. No memory/
// index retrieval here, so a command never spikes RAM. Pure + DI → tests offline.
import { addReminder } from './reminders.mjs';
import { appendDraft } from '../store.mjs';

const clean = (s, n = 280) => (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim().slice(0, n);

// Strip an optional wake-word prefix ("Continuum, …" / "Hey Continuum …") so the parser works whether
// the trigger is a wake-word or whole-transcript intent detection.
const WAKE = /^\s*(?:hey\s+|ok\s+)?continuum[\s,:.!-]*/i;
export const stripWake = (t) => (t || '').replace(WAKE, '');
export const isCommand = (t) => WAKE.test(t || '');   // used to ROUTE audio utterances to the assistant

const REMIND = /^(?:remind me to|reminder to|remind me|set (?:a )?reminder to|note to self[:,]?|don'?t forget to)\s+(.+)/i;
const DRAFT = /^(?:draft|write|compose|reply|send)\s+(?:an?\s+)?(?:e-?mail|message|reply|note|mail)\s+(.+)/i;

// Parse a (wake-word-stripped) command into a structured intent. action 'none' if it isn't one.
export function parseIntent(transcript) {
  const t = clean(stripWake(transcript), 400);
  let m = t.match(REMIND);
  if (m) return { action: 'reminder', text: clean(m[1]) };
  m = t.match(DRAFT);
  if (m) {
    const rest = m[1];
    const to = (rest.match(/\bto\s+([A-Z][\w .'\-]{1,40}?)(?:\s+(?:about|regarding|re|saying|that|on)\b|[,.]|$)/i) || [])[1] || '';
    const about = (rest.match(/\b(?:about|regarding|re|saying|that|on)\s+(.+)$/i) || [])[1] || rest;
    return { action: 'draft', to: clean(to, 80), instruction: clean(about) };
  }
  return { action: 'none' };
}

// Compose an email draft. With an LLM: one transient, grounded-only-in-the-instruction call (no
// retrieval → no RAM). Without: a plain template, so the offline path still produces something usable.
async function composeDraft({ to, instruction }, llm) {
  if (llm) {
    try {
      const raw = await llm(
        'Write a short, professional email from this instruction. Return ONLY JSON {"to":"","subject":"","body":""}. Keep the body concise; do not invent facts the instruction does not give.',
        `Recipient: ${to || '(unspecified)'}\nInstruction: ${instruction}`, 300,
      );
      const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      return { to: clean(p.to || to, 120), subject: clean(p.subject || '', 160), body: clean(p.body || '', 4000) };
    } catch { /* fall through to template */ }
  }
  const subject = clean(instruction, 60);
  return { to: clean(to, 120), subject, body: `Hi${to ? ' ' + to.split(/\s/)[0] : ''},\n\n${clean(instruction, 1000)}\n\nThanks,` };
}

// Execute a command transcript. Returns { ok, action, message, ... } for the feedback channel.
export async function runCommand(transcript, { llm, now = Date.now() } = {}) {
  const intent = parseIntent(transcript);
  if (intent.action === 'reminder') {
    const r = addReminder(intent.text, { now });
    return { ok: true, action: 'reminder', message: `Reminder set: ${r.text}${r.dueMs ? ' (due ' + new Date(r.dueMs).toLocaleDateString() + ')' : ''}`, item: r };
  }
  if (intent.action === 'draft') {
    const d = await composeDraft(intent, llm);
    const draft = { id: `draft_${now}`, ...d, created: now };
    appendDraft(draft);
    return { ok: true, action: 'draft', message: `Draft ready${draft.to ? ' to ' + draft.to : ''}: ${draft.subject || '(no subject)'}`, draft };
  }
  return { ok: false, action: 'none', message: "Didn't catch a command — try \"remind me to…\" or \"draft an email to…\"." };
}
