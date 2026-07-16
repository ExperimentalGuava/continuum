// Detect what AI the user already has, and turn that into a Continuum config.
//
// Two halves, kept separate so the decision logic is testable with no network:
//   detectEnvironment() — probes the machine (Ollama, API keys, Claude Desktop).
//   chooseConfig()      — pure: given a detection snapshot, pick providers + models.
//
// Philosophy: adjust to whatever is already set up, and never make things worse.
// If nothing is found we stay on the free, fully-local default (llm: none) — setup
// is always safe to run and never requires a key.
import fs from 'node:fs';

// ---- live probes (injectable for tests) --------------------------------------

// Ask a local Ollama what models it has. Short timeout so a missing/paused Ollama
// doesn't stall setup. Returns { running, models, chatModels, embedModels }.
export async function probeOllama({ base = 'http://localhost:11434', fetchImpl = fetch, timeoutMs = 700 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(base + '/api/tags', { signal: ctrl.signal });
    if (!r.ok) return { running: false, models: [], chatModels: [], embedModels: [] };
    const j = await r.json();
    const models = (j.models || []).map((m) => m.name).filter(Boolean);
    const embedModels = models.filter((n) => /embed/i.test(n));
    const chatModels = models.filter((n) => !/embed/i.test(n));
    return { running: true, models, chatModels, embedModels };
  } catch {
    return { running: false, models: [], chatModels: [], embedModels: [] };
  } finally {
    clearTimeout(timer);
  }
}

// Gather the full picture. `deps` is injectable so tests never touch the real machine.
export async function detectEnvironment(deps = {}) {
  const {
    env = process.env,
    fileKeys = {},                       // keys already saved in ~/.continuum/config.json
    claudeConfigPath,                    // () => path
    existsSync = fs.existsSync,
    probe = probeOllama,
  } = deps;

  const keys = {
    // env wins over saved file; we only record presence + source, never the value here.
    openai: env.OPENAI_API_KEY ? 'env' : fileKeys.openai ? 'config' : '',
    anthropic: env.ANTHROPIC_API_KEY ? 'env' : fileKeys.anthropic ? 'config' : '',
  };

  const ollama = await probe(deps.ollama || {});

  let claudeDesktop = false;
  try { claudeDesktop = !!(claudeConfigPath && existsSync(resolvePath(claudeConfigPath))); } catch { claudeDesktop = false; }

  return { keys, ollama, claudeDesktop };
}

// claudeConfigPath may be a function or a string — normalize to a string.
function resolvePath(v) { return typeof v === 'function' ? v() : v; }

// ---- pure decision -----------------------------------------------------------

// Pick the best Ollama chat model: prefer a known-capable default if present.
function pickChatModel(chatModels) {
  const prefer = ['llama3.1', 'llama3.2', 'llama3', 'qwen2.5', 'mistral'];
  for (const p of prefer) {
    const hit = chatModels.find((m) => m === p || m.startsWith(p + ':'));
    if (hit) return hit;
  }
  return chatModels[0];
}

function pickEmbedModel(embedModels) {
  const hit = embedModels.find((m) => /nomic-embed-text/i.test(m));
  return hit || embedModels[0];
}

// Given a detection snapshot, decide llm + embeddings providers/models.
// Returns { llm, embeddings, reasons } — reasons is a human-readable trail.
export function chooseConfig(det) {
  const reasons = [];
  const llm = { provider: 'none', model: '' };
  const embeddings = { provider: 'local', model: '' };

  // LLM: a real key beats local; Anthropic first (the product's native pairing),
  // then OpenAI, then a local Ollama chat model, else stay local (none).
  if (det.keys.anthropic) {
    llm.provider = 'anthropic'; llm.model = 'claude-sonnet-4-6';
    reasons.push(`Anthropic key found (${det.keys.anthropic}) → LLM: Claude`);
  } else if (det.keys.openai) {
    llm.provider = 'openai'; llm.model = 'gpt-4o-mini';
    reasons.push(`OpenAI key found (${det.keys.openai}) → LLM: GPT`);
  } else if (det.ollama.running && det.ollama.chatModels.length) {
    llm.provider = 'ollama'; llm.model = pickChatModel(det.ollama.chatModels);
    reasons.push(`Ollama is running → LLM: ${llm.model} (local, free)`);
  } else {
    reasons.push('No API key or local model found → staying fully local (no LLM). Capture + search still work.');
  }

  // Embeddings: OpenAI has an embeddings API (Anthropic does not), then a local
  // Ollama embed model, else the built-in hashed embedder.
  if (det.keys.openai) {
    embeddings.provider = 'openai'; embeddings.model = 'text-embedding-3-small';
    reasons.push('OpenAI key → embeddings: text-embedding-3-small');
  } else if (det.ollama.running && det.ollama.embedModels.length) {
    embeddings.provider = 'ollama'; embeddings.model = pickEmbedModel(det.ollama.embedModels);
    reasons.push(`Ollama embed model → embeddings: ${embeddings.model} (local)`);
  } else {
    reasons.push('Embeddings: built-in local (hashed, instant, zero-dep).');
  }

  return { llm, embeddings, reasons };
}

// Classify a pasted API key by its prefix so setup knows which provider it unlocks.
// Anthropic keys start with `sk-ant-`; OpenAI keys start with `sk-`. Returns
// { provider, key } or null when the input is empty / not a recognizable key.
export function classifyKey(input) {
  const key = (input || '').trim();
  if (!key) return null;
  if (/^sk-ant/i.test(key)) return { provider: 'anthropic', key };
  if (/^sk-/i.test(key)) return { provider: 'openai', key };
  return null;
}

// Merge chosen providers into an existing raw config without clobbering unrelated
// settings or persisting any secret (keys stay in env / are set by the user).
export function applyChoice(rawConfig, choice) {
  const next = { ...rawConfig };
  next.llm = { ...(rawConfig.llm || {}), provider: choice.llm.provider, model: choice.llm.model };
  next.embeddings = { ...(rawConfig.embeddings || {}), provider: choice.embeddings.provider, model: choice.embeddings.model };
  return next;
}
