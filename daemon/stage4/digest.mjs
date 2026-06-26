// Stage 4 — the digest surface. Turns openTasks() into a proactive summary ("here's what you
// committed to and haven't closed, overdue first") and delivers it to a chat webhook (Teams/Slack).
// A scheduled task runs `continuum digest` daily; this module is the pure formatter + delivery seam.

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// Format the open commitments into a chat-ready message. Overdue first, then still-open.
export function formatDigest(tasks, { now = Date.now(), title = 'Open commitments' } = {}) {
  const date = fmtDate(now);
  if (!tasks.length) return `✅ ${title} — ${date}\n\nNothing open. You're all caught up.`;

  const overdue = tasks.filter((t) => t.status === 'overdue');
  const open = tasks.filter((t) => t.status !== 'overdue');
  const line = (t) => `• ${t.text}${t.dueMs ? ` (due ${fmtDate(t.dueMs)})` : ''} — ${t.app}`;

  const L = [`📋 ${title} — ${date}`, `${tasks.length} open${overdue.length ? `, ${overdue.length} overdue` : ''}`, ''];
  if (overdue.length) { L.push('⚠ Overdue'); overdue.forEach((t) => L.push(line(t))); L.push(''); }
  if (open.length) { L.push('Still open'); open.forEach((t) => L.push(line(t))); }
  return L.join('\n').trim();
}

// POST the digest to an incoming webhook. Slack and Teams (Power Automate) both accept {text}.
// fetchImpl is injectable for tests. Returns { ok, status?, reason? }.
export async function deliverDigest(text, { webhook, fetchImpl = fetch } = {}) {
  if (!webhook) return { ok: false, reason: 'no webhook configured' };
  try {
    const r = await fetchImpl(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const ok = r.ok ?? (r.status >= 200 && r.status < 300);
    return { ok, status: r.status };
  } catch (e) { return { ok: false, reason: e.message }; }
}
