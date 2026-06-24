// Stage 3 — vision-completion seam (#9): gating + grounded passthrough.
import { noopVisionParser, needsVisionCompletion, completeScene } from './vision.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nStage 3 vision-completion seam\n');

const axBlind = { app: 'Slack', text: 'a flat OCR capture with no AX scene' };
const axHas = { app: 'Notes', text: 'has hierarchy', scene: { role: 'AXWindow', children: [{ role: 'AXTextArea', text: 'note body' }] } };

// gating
ok('gate: AX-blind + changed + plugged-in → run', needsVisionCompletion(axBlind, { changed: true, onBattery: false }));
ok('gate: AX present → skip', needsVisionCompletion(axHas) === false);
ok('gate: unchanged frame → skip', needsVisionCompletion(axBlind, { changed: false }) === false);
ok('gate: on battery → skip (energy budget)', needsVisionCompletion(axBlind, { onBattery: true }) === false);
ok('gate: thermal pressure → skip', needsVisionCompletion(axBlind, { thermal: 'serious' }) === false);

// default no-op ships safe: nothing added, OCR stays the floor
{
  const out = await completeScene(axBlind, noopVisionParser, { changed: true });
  ok('no-op parser leaves the event unchanged', out.scene === undefined);
}

// a real parser fills the scene where AX was blind, tagged with provenance
{
  const fake = async ({ text }) => [{ role: 'group', type: 'message', text }];
  const out = await completeScene(axBlind, fake, { changed: true });
  ok('parser completes the scene when gated in', out.scene && out.scene.children.length === 1);
  ok('completed scene is tagged vision-derived', out.scene.source === 'vision');
  ok('completed region text is grounded in the capture', out.scene.children[0].text === axBlind.text);
}

// never overrides an AX scene
{
  const fake = async () => [{ role: 'group', text: 'should not appear' }];
  const out = await completeScene(axHas, fake);
  ok('AX scene is never overridden by vision', out.scene.children[0].text === 'note body');
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
