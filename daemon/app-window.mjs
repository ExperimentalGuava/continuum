// Open the local dashboard as a native-feeling desktop window instead of a browser tab.
//
// The dashboard is already a local HTTP server (localhost:3939). To make it feel like
// an app — its own window and taskbar/dock icon, no address bar or tabs — we launch a
// Chromium engine (Edge/Chrome/Brave, already on nearly every machine) in "app mode"
// (--app=URL). That reuses the existing dashboard UI as-is, with zero new dependencies
// and no bundled runtime. If no Chromium engine is found we fall back to the default
// browser so the user still gets the dashboard.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Candidate Chromium executables per platform, in preference order.
function chromiumCandidates() {
  const p = process.platform;
  if (p === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    const rel = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ];
    return roots.flatMap((r) => rel.map((parts) => path.join(r, ...parts)));
  }
  if (p === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  // linux — resolved from PATH below
  return ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
}

function resolveFromPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    const full = path.join(d, name);
    try { if (fs.statSync(full).isFile()) return full; } catch { /* not here */ }
  }
  return null;
}

function findChromium() {
  for (const c of chromiumCandidates()) {
    if (c.includes(path.sep) || c.includes('/')) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ }
    } else {
      const r = resolveFromPath(c);
      if (r) return r;
    }
  }
  return null;
}

// Open `url` in a chromeless app window. Returns true if a Chromium window was launched,
// false if we fell back to the default browser.
export function openAppWindow(url, { width = 1080, height = 760 } = {}) {
  const bin = findChromium();
  if (bin) {
    // A dedicated profile dir keeps the app window separate from the user's browsing
    // session (own icon, no shared tabs/state).
    const profile = path.join(os.tmpdir(), 'continuum-app');
    const args = [`--app=${url}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--no-first-run'];
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    // spawn reports a bad/missing binary via an async 'error' event, not a throw —
    // swallow it (and fall back) instead of letting it crash the process.
    child.on('error', () => openInBrowser(url));
    child.unref();
    return true;
  }
  openInBrowser(url);
  return false;
}

// Fallback: hand the URL to the OS default browser.
export function openInBrowser(url) {
  const p = process.platform;
  const [cmd, args] = p === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : p === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* no opener available (e.g. headless) — the URL is still printed by the caller */ });
  child.unref();
}
