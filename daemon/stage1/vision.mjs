// Stage 3 — vision-completion SEAM (#9). Where the accessibility tree exposes no hierarchy (gated
// Chromium/Electron, canvas, games), a small on-device vision parser completes the scene graph. The
// actual CoreML detector is a separate ML effort (distill a Screen2AX/OmniParser-lineage model to
// CoreML/ANE — see docs/architecture/perception.md §5, Stage 3). This file is the integration seam +
// the gating so a real parser drops in cleanly; until then the no-op keeps OCR as the grounded floor.
//
// A VisionParser is:  async (input) => Array<{ role, type, text, bbox, children? }> | null
//   input: { app, text, bbox? } — a reference to the captured region. Text it returns must be
//   EXTRACTED from real content (grounded), never invented (perception.md §2.1).

export const noopVisionParser = async () => null;   // default: no completion, no fabrication

// Gate the (expensive, energy-heavy) parser: run it ONLY when it can help AND we can afford it —
//  - AX gave us nothing usable (no scene / empty scene) → vision can add real value
//  - the screen meaningfully changed → don't re-parse a static frame
//  - not on battery and not thermally throttled → we're a recorder, energy is the budget (§7)
export function needsVisionCompletion(ev, { changed = true, onBattery = false, thermal = 'nominal' } = {}) {
  const s = ev && ev.scene;
  const hasScene = !!(s && ((s.children && s.children.length) || s.text));
  return !hasScene && changed && !onBattery && thermal === 'nominal';
}

// Apply a parser under the gate. Provenance is tagged (`source: 'vision'`) so downstream knows the
// hierarchy is vision-derived, not AX-exact.
export async function completeScene(ev, parser = noopVisionParser, gateOpts = {}) {
  if (!needsVisionCompletion(ev, gateOpts)) return ev;
  const regions = await parser({ app: ev.app, text: ev.text, bbox: ev.bbox });
  if (!regions || !regions.length) return ev;
  return { ...ev, scene: { role: 'AXWindow', source: 'vision', children: regions } };
}
