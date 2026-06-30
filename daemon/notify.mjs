// User-facing notifications — the feedback channel for voice commands ("Reminder set ✓"). On Windows
// it shows a native toast via PowerShell/WinRT (no dependency, no module install); elsewhere it logs.
// Best-effort and fire-and-forget: a failed toast must never break capture. The dashboard also surfaces
// the last action (see store last-action), so a missed toast still has a guaranteed fallback.
import { spawn } from 'node:child_process';

// Title/body are passed via ENV (not interpolated into the command string) so arbitrary text — quotes,
// newlines — can't break or inject into the PowerShell. ToastText02 = bold title + one body line.
const PS = `
$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null
$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t=$x.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($x.CreateTextNode($env:CONTINUUM_NOTIFY_TITLE))
[void]$t.Item(1).AppendChild($x.CreateTextNode($env:CONTINUUM_NOTIFY_BODY))
$toast=[Windows.UI.Notifications.ToastNotification]::new($x)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Continuum').Show($toast)
`;

export function notify(title, body) {
  if (process.platform !== 'win32') {
    console.error(`  🔔 ${title}: ${body}`);   // dev/mac: the dashboard toast is the real surface
    return;
  }
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
      env: { ...process.env, CONTINUUM_NOTIFY_TITLE: String(title || 'Continuum'), CONTINUUM_NOTIFY_BODY: String(body || '') },
    });
    child.unref();
  } catch { /* best-effort — never let a toast failure affect capture */ }
}
