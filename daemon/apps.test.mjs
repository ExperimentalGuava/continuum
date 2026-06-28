// Run:  node daemon/apps.test.mjs
import { matchesAllow, allowPatterns, APP_CLASSES, classOf } from './apps.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nApp allowlist (capture targeting)\n');

ok('canonical work-app classes present', APP_CLASSES.length === 8, `n=${APP_CLASSES.length}`);
ok('Office (Excel) classifies as office', classOf('excel Q3 Budget.xlsx - Excel') === 'office');
ok('Jira (web title) classifies as atlassian', classOf('chrome PROJ-1 - Jira') === 'atlassian');
ok('Anaplan classifies', classOf('anaplan model') === 'anaplan');
ok('native desktop app matches by name', matchesAllow('Outlook'));
ok('native Teams matches', matchesAllow('Microsoft Teams'));
ok('web Jira matches via window title', matchesAllow('chrome [PROJ-128] Fix login bug - Jira'));
ok('web Salesforce matches via title', matchesAllow('msedge Acme Pty Ltd | Salesforce'));
ok('web Outlook matches via title', matchesAllow('chrome Inbox - jane@firm.com.au - Outlook'));
ok('non-work app is filtered out', !matchesAllow('Spotify Premium'));
ok('empty allowlist = capture everything', matchesAllow('Spotify', []));
ok('allowPatterns is the flat substring list', allowPatterns().includes('jira') && allowPatterns().includes('servicenow'));

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
