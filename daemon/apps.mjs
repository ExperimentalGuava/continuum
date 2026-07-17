// Canonical work-correspondence app classes — the capture allowlist and the single source of
// truth shared by the task extractor (Node) and the native capture daemon (via CONTINUUM_ALLOW).
//
// Tuned for the Australian corporate stack, which is heavily Microsoft + Atlassian. Matching is on
// app name OR window title, because much of this runs in a BROWSER (Outlook web, Jira Cloud,
// Salesforce, ServiceNow) where the process is "chrome"/"msedge" and the real app is in the title.
export const APP_CLASSES = [
  { key: 'outlook',    label: 'Outlook / Microsoft 365 mail + calendar', patterns: ['outlook', 'olk', 'office365', 'microsoft 365'] },
  { key: 'teams',      label: 'Microsoft Teams',                          patterns: ['teams'] },
  { key: 'atlassian',  label: 'Jira / Confluence (Atlassian)',           patterns: ['jira', 'confluence', 'atlassian'] },
  { key: 'slack',      label: 'Slack',                                    patterns: ['slack'] },
  { key: 'servicenow', label: 'ServiceNow',                               patterns: ['servicenow', 'service-now'] },
  { key: 'salesforce', label: 'Salesforce',                               patterns: ['salesforce', 'force.com', 'lightning'] },
  { key: 'office',     label: 'Microsoft Office (Word/Excel/PowerPoint)', patterns: ['winword', 'excel', 'powerpnt', 'powerpoint'] },
  { key: 'anaplan',    label: 'Anaplan',                                  patterns: ['anaplan'] },
];

// Flat substring list handed to the daemon via env, and the default for the Node-side filter.
export const allowPatterns = () => APP_CLASSES.flatMap((c) => c.patterns);

// Does this captured context (app + window title + url host, any combination) belong to an allowed
// work app? Empty allow = match everything (capture-all, the pre-allowlist behavior).
export function matchesAllow(haystack, allow = allowPatterns()) {
  if (!allow || allow.length === 0) return true;
  const h = (haystack || '').toLowerCase();
  return allow.some((p) => h.includes(p));
}

// The APP_CLASSES key this context (app + title + url host) belongs to, or null. First match wins,
// in declaration order. Used by the typed extractor to route an episode to email/ticket/etc.
export function classOf(haystack) {
  const h = (haystack || '').toLowerCase();
  for (const c of APP_CLASSES) if (c.patterns.some((p) => h.includes(p))) return c.key;
  return null;
}

// The serviced apps, for the UI to list (key + friendly label).
export const servicedApps = () => APP_CLASSES.map((c) => ({ key: c.key, label: c.label }));

// Expand a user exclude list into the substring patterns the capture engine matches on. An entry
// that's a curated class key ("outlook") expands to all its patterns (outlook, olk, …) so the whole
// serviced app is excluded; any other entry passes through as a literal substring (legacy names).
export function expandExcludes(excludes = []) {
  const out = [];
  for (const e of excludes) {
    const cls = APP_CLASSES.find((c) => c.key === e);
    if (cls) out.push(...cls.patterns); else out.push(e);
  }
  return [...new Set(out)];
}
