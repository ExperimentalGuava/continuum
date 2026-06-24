// Line-level novelty filter — capture the whole window, suppress repeated chrome.
import { LineNovelty } from './novelty.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nLine-level novelty (whole-window, no chrome re-encode)\n');

const chrome = 'Bookmarks Bar  UMass  Learn  Morning Brew  Libby  All Bookmarks';
const cap = (t, content) => ({ t, app: 'Chrome', window_id: 'Chrome|x', text: [chrome, content].join('\n') });

const nf = new LineNovelty();
const e1 = nf.filter(cap(0, 'Article: the intro paragraph about temporal graphs'));
ok('first capture keeps the whole window (chrome + content)', /Bookmarks Bar/.test(e1.text) && /intro paragraph/.test(e1.text));

const e2 = nf.filter(cap(2500, 'Article: the second paragraph about vector indexes'));
ok('repeated chrome is suppressed', !/Bookmarks Bar/.test(e2.text) && !/All Bookmarks/.test(e2.text), e2 && e2.text);
ok('changed content is kept', /second paragraph/.test(e2.text));

const e3 = nf.filter({ t: 5000, app: 'Chrome', window_id: 'Chrome|x', text: chrome });
ok('pure chrome refresh → skipped (null)', e3 === null);

// chrome suppressed across a DIFFERENT page (window title) of the SAME app — keyed per-app
const e4 = nf.filter({ t: 6000, app: 'Chrome', window_id: 'Chrome|other-page', text: [chrome, 'a brand new article on a different page'].join('\n') });
ok('same app, new page → chrome NOT re-captured', e4 && !/Bookmarks Bar/.test(e4.text) && /different page/.test(e4.text), e4 && e4.text);

// a different APP is independent (its own chrome is real content the first time)
const e4b = nf.filter({ t: 6500, app: 'Safari', window_id: 'Safari|x', text: chrome });
ok('a different app is independent', e4b && /Bookmarks Bar/.test(e4b.text));

const e5 = nf.filter(cap(7 * 60_000, 'Article: a later paragraph'));
ok('after TTL, chrome is fresh again (scroll-back / real change)', /Bookmarks Bar/.test(e5.text));

// no regression: distinct single-line captures pass through unchanged
{
  const f = new LineNovelty();
  const a = f.filter({ t: 0, app: 'Editor', window_id: 'Editor', text: 'composing an email to the design team about the deck' });
  const b = f.filter({ t: 1, app: 'Editor', window_id: 'Editor', text: 'composing an email to the design team about the deck timeline' });
  ok('distinct content is never dropped', a && b && /timeline/.test(b.text));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
