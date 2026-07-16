// detect — the "configure to whatever AI is installed" decision logic.
// Pure + injected probes: no network, no real machine state.
import { chooseConfig, applyChoice, detectEnvironment, probeOllama } from './detect.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${x}`); } };

console.log('\nDetect (configure to whatever AI is installed)\n');

const noOllama = { running: false, models: [], chatModels: [], embedModels: [] };

// --- chooseConfig: LLM priority -------------------------------------------------
{
  const c = chooseConfig({ keys: { anthropic: 'env', openai: '' }, ollama: noOllama });
  ok('Anthropic key → LLM claude', c.llm.provider === 'anthropic' && /claude/.test(c.llm.model), JSON.stringify(c.llm));
}
{
  const c = chooseConfig({ keys: { anthropic: '', openai: 'env' }, ollama: noOllama });
  ok('OpenAI key (no anthropic) → LLM gpt', c.llm.provider === 'openai' && /gpt/.test(c.llm.model), JSON.stringify(c.llm));
  ok('OpenAI key → embeddings openai', c.embeddings.provider === 'openai', JSON.stringify(c.embeddings));
}
{
  const c = chooseConfig({ keys: { anthropic: 'env', openai: 'env' }, ollama: noOllama });
  ok('Both keys → Anthropic wins for LLM', c.llm.provider === 'anthropic', c.llm.provider);
  ok('Both keys → OpenAI still used for embeddings', c.embeddings.provider === 'openai', c.embeddings.provider);
}

// --- chooseConfig: Ollama fallback ---------------------------------------------
{
  const ollama = { running: true, models: ['llama3.1', 'nomic-embed-text'], chatModels: ['llama3.1'], embedModels: ['nomic-embed-text'] };
  const c = chooseConfig({ keys: { anthropic: '', openai: '' }, ollama });
  ok('No key, Ollama running → LLM ollama', c.llm.provider === 'ollama' && c.llm.model === 'llama3.1', JSON.stringify(c.llm));
  ok('No key, Ollama embed model → embeddings ollama', c.embeddings.provider === 'ollama' && c.embeddings.model === 'nomic-embed-text', JSON.stringify(c.embeddings));
}
{
  const ollama = { running: true, models: ['mistral:latest'], chatModels: ['mistral:latest'], embedModels: [] };
  const c = chooseConfig({ keys: { anthropic: '', openai: '' }, ollama });
  ok('Ollama chat only → LLM ollama, embeddings stay local', c.llm.provider === 'ollama' && c.embeddings.provider === 'local', JSON.stringify(c));
  ok('picks the available chat model', c.llm.model === 'mistral:latest', c.llm.model);
}
{
  const ollama = { running: true, models: ['llama3.2:3b', 'qwen2.5'], chatModels: ['llama3.2:3b', 'qwen2.5'], embedModels: [] };
  const c = chooseConfig({ keys: { anthropic: '', openai: '' }, ollama });
  ok('prefers a known-good model (llama3.2) over first-seen', c.llm.model === 'llama3.2:3b', c.llm.model);
}

// --- chooseConfig: nothing installed → safe local default -----------------------
{
  const c = chooseConfig({ keys: { anthropic: '', openai: '' }, ollama: noOllama });
  ok('Nothing found → LLM none (fully local)', c.llm.provider === 'none', c.llm.provider);
  ok('Nothing found → embeddings local', c.embeddings.provider === 'local', c.embeddings.provider);
  ok('reasons are explained to the user', c.reasons.length >= 2, String(c.reasons.length));
}

// --- applyChoice: merge without clobbering or leaking keys ----------------------
{
  const raw = { tier: 'free', keys: { openai: 'sk-secret' }, capture: { audio: false }, llm: { provider: 'none' } };
  const c = chooseConfig({ keys: { anthropic: '', openai: 'config' }, ollama: noOllama });
  const next = applyChoice(raw, c);
  ok('preserves unrelated config (capture)', next.capture && next.capture.audio === false);
  ok('preserves existing keys untouched', next.keys.openai === 'sk-secret');
  ok('writes the chosen llm provider', next.llm.provider === 'openai');
  ok('writes the chosen embeddings provider', next.embeddings.provider === 'openai');
}

// --- probeOllama: timeouts/errors resolve to not-running, never throw ------------
{
  const dead = await probeOllama({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  ok('probe swallows connection error → running:false', dead.running === false && dead.models.length === 0);

  const good = await probeOllama({ fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.1' }, { name: 'nomic-embed-text' }] }) }) });
  ok('probe classifies chat vs embed models', good.running && good.chatModels.includes('llama3.1') && good.embedModels.includes('nomic-embed-text'), JSON.stringify(good));
}

// --- detectEnvironment: keys by source, Claude Desktop presence -----------------
{
  const det = await detectEnvironment({
    env: { ANTHROPIC_API_KEY: 'sk-ant' },
    fileKeys: { openai: 'sk-file' },
    claudeConfigPath: () => '/does/exist',
    existsSync: (p) => p === '/does/exist',
    probe: async () => noOllama,
  });
  ok('anthropic key sourced from env', det.keys.anthropic === 'env', det.keys.anthropic);
  ok('openai key sourced from config file', det.keys.openai === 'config', det.keys.openai);
  ok('Claude Desktop detected via existing config path', det.claudeDesktop === true);
}
{
  const det = await detectEnvironment({
    env: {}, fileKeys: {},
    claudeConfigPath: () => '/nope', existsSync: () => false,
    probe: async () => noOllama,
  });
  ok('no Claude Desktop when config path missing', det.claudeDesktop === false);
  ok('no keys when neither env nor file', det.keys.openai === '' && det.keys.anthropic === '');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
