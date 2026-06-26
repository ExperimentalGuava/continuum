// Canonical work-correspondence app classes — the capture allowlist and the single source of
// truth shared by the task extractor (Node) and the native capture daemon (via CONTINUUM_ALLOW).
//
// Tuned for the Australian corporate stack, which is heavily Microsoft + Atlassian. Matching is on
// app name OR window title, because much of this runs in a BROWSER (Outlook web, Jira Cloud,
// Salesforce, ServiceNow) where the process is "chrome"/"msedge" and the real app is in the title.
export const APP_CLASSES = [
  { key: 'outlook',    label: 'Outlook / Microsoft 365 mail + calendar', patterns: ['outlook', 'office365', 'microsoft 365'] },
  { key: 'teams',      label: 'Microsoft Teams',                          patterns: ['teams'] },
  { key: 'atlassian',  label: 'Jira / Confluence (Atlassian)',           patterns: ['jira', 'confluence', 'atlassian'] },
  { key: 'slack',      label: 'Slack',                                    patterns: ['slack'] },
  { key: 'servicenow', label: 'ServiceNow',                               patterns: ['servicenow', 'service-now'] },
  { key: 'salesforce', label: 'Salesforce',                               patterns: ['salesforce', 'force.com', 'lightning'] },
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
