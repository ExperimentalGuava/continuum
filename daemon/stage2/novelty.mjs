// Line-level novelty filter — capture the WHOLE window like a human sees it, but don't
// re-memorize the bookmark bar every 2.5 seconds. Across consecutive captures of the same window,
// chrome (nav/toolbar/bookmarks) repeats verbatim while content changes. So we keep every line the
// first time (chrome included, as context), then suppress lines already seen recently for that
// window — capturing stable chrome once and re-encoding only what actually changed. Nothing is
// cropped; the redundant-chrome noise (the 67%/repetition problem) just stops drowning the signal.
//
// Lines re-novel after `ttlMs` (so scrolling back, or chrome that genuinely changed, is captured
// again). Keyed on word tokens, so OCR spacing/punctuation jitter doesn't defeat the match.

const WORD = /[a-z0-9]+/gi;
const keyOf = (line) => (line.toLowerCase().match(WORD) || []).join(' ');

export class LineNovelty {
  constructor({ ttlMs = 5 * 60_000, maxPerWindow = 800, minChars = 3 } = {}) {
    this.ttlMs = ttlMs; this.maxPerWindow = maxPerWindow; this.minChars = minChars;
    this.seen = new Map();   // window_id -> Map(lineKey -> lastSeenTs)
  }

  // Returns the event with already-seen lines stripped, or null if nothing new (pure chrome refresh).
  filter(ev) {
    if (!ev || typeof ev.text !== 'string') return ev;
    // Key by APP, not window title: the bookmark bar / toolbar is identical across every page of a
    // browser, so suppress it once per app rather than re-capturing it on each page navigation.
    const akey = ev.app || ev.window_id || 'unknown';
    const t = ev.t || 0;
    let mem = this.seen.get(akey);
    if (!mem) { mem = new Map(); this.seen.set(akey, mem); }

    const kept = [];
    for (const raw of ev.text.split(/\n+/)) {
      const line = raw.trim();
      if (line.length < this.minChars) continue;
      const k = keyOf(line);
      if (!k) continue;
      const last = mem.get(k);
      const fresh = last == null || (t - last) > this.ttlMs;   // unseen, or seen long enough ago to re-encode
      mem.set(k, t);                                           // mark seen-now (keeps stable chrome "recent")
      if (fresh) kept.push(line);
    }

    if (mem.size > this.maxPerWindow) {                        // bound memory: evict oldest keys
      const old = [...mem.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < old.length - this.maxPerWindow; i++) mem.delete(old[i][0]);
    }

    if (!kept.length) return null;                            // nothing novel → skip this capture entirely
    return { ...ev, text: kept.join('\n') };
  }
}
