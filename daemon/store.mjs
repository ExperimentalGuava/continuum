// Persistence — a simple append-only NDJSON episode log. Decouples the capture daemon
// from the query interfaces (CLI / MCP / dashboard): capture appends, readers rebuild
// the index. Local-first, debuggable, greppable.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { HybridIndex } from './stage3/index.mjs';

export const STORE_FILE = path.join(DATA_DIR, 'episodes.ndjson');

export function appendEpisode(ep) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(STORE_FILE, JSON.stringify(ep) + '\n');
}

export function loadEpisodes() {
  try { return fs.readFileSync(STORE_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
}

export async function loadIndex(embed) {
  const idx = new HybridIndex({ embed });
  for (const ep of loadEpisodes()) await idx.add(ep);
  return idx;
}

// Rewrite the store keeping only episodes for which keepFn is true. Returns # remaining.
// Used by the dashboard's delete / clear controls (the trust center).
export function rewriteEpisodes(keepFn) {
  const kept = loadEpisodes().filter(keepFn);
  fs.writeFileSync(STORE_FILE, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
  return kept.length;
}

// Retention discharge: drop episodes older than `days`, EXCEPT those isPinned (e.g. linked to an
// open task — kept regardless of age). days <= 0 disables (keep everything). Timestamp is ms epoch;
// episodes carry `end` (last active) with start/t fallbacks. Returns { remaining, pruned }.
export function pruneEpisodes({ days = 7, now = Date.now(), isPinned = () => false } = {}) {
  if (!days || days <= 0) return { remaining: loadEpisodes().length, pruned: 0 };
  const floor = now - days * 864e5;
  const stamp = (e) => e.end ?? e.start ?? e.t ?? 0;
  let pruned = 0;
  const remaining = rewriteEpisodes((e) => {
    const keep = stamp(e) >= floor || isPinned(e);
    if (!keep) pruned += 1;
    return keep;
  });
  return { remaining, pruned };
}
