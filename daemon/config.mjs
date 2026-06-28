// Config + tier resolution. The whole product surface in one place.
//
// Tiers (the "shovel" business model):
//   free        — fully local (Ollama) or hashed fallback. Capture + segment + vector
//                 recall + on-device summaries. $0, private, no key. NO graph.
//   pro         — bring an OpenAI/Anthropic key (or our hosted endpoint). Adds the
//                 temporal knowledge graph (entity/relation extraction needs a frontier
//                 model — local models provably can't satisfy the schemas).
//   enterprise  — self-hosted or cloud, team graph, SSO. (sales)
//
// Resolution order: ~/.continuum/config.json  <  environment variables.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  localEmbedder, ollamaEmbedder, openaiEmbedder, apiEmbedder,
  llmClient, ollamaLLM, graphClient,
} from './adapters.mjs';
import { allowPatterns } from './apps.mjs';

export const DATA_DIR = process.env.CONTINUUM_DATA || path.join(os.homedir(), '.continuum');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Claude Desktop's config location — platform-specific. Used by mcp-install (CLI) and the
// dashboard's "connected?" check, so both agree on one path.
export const claudeConfigPath = () => process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
  : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const CFG_PATH = CONFIG_PATH;

// Raw file read/write (no env overlay, no defaults) — for the dashboard Control panel to
// persist user choices (exclusions, etc.) without clobbering other settings or leaking keys.
export function readRawConfig() { try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { return {}; } }
export function writeRawConfig(obj) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CFG_PATH, JSON.stringify(obj, null, 2) + '\n'); }

const DEFAULTS = {
  tier: 'free',
  capture:    { source: 'screen', exclude: [], audio: false, allow: allowPatterns(), egress: 'authored' },  // screen (OCR) | ax; allow = only these work apps (by name OR window title; [] = capture all); exclude = never captured; audio = meetings (opt-in); egress = what may leave the device on the LLM pass: 'authored' (only your own content) | 'all'
  files:      { watch: [] },                          // dirs to capture writes from, e.g. ["~/Documents", "~/code"]
  embeddings: { provider: 'local', model: '' },     // local | ollama | openai | api
  llm:        { provider: 'none',  model: '' },      // none | ollama | openai | anthropic
  graph:      { enabled: false, url: 'http://localhost:8000', group: 'default' },
  keys:       { openai: '', anthropic: '' },
  mcp:        { paused: false, sinceDays: 0 },        // agent access controls: pause, or limit to a recent window (0 = all)
  retention:  { days: 7 },                            // discharge raw episodes older than this; 0 = keep all. Task-linked kept regardless.
  digest:     { webhook: '' },                        // chat webhook (Teams/Slack) for the scheduled open-task digest; empty = print only
};

export function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch { /* none yet */ }
  const cfg = {
    ...DEFAULTS, ...file,
    capture: { ...DEFAULTS.capture, ...file.capture },
    files: { ...DEFAULTS.files, ...file.files },
    embeddings: { ...DEFAULTS.embeddings, ...file.embeddings },
    llm: { ...DEFAULTS.llm, ...file.llm },
    graph: { ...DEFAULTS.graph, ...file.graph },
    mcp: { ...DEFAULTS.mcp, ...file.mcp },
    retention: { ...DEFAULTS.retention, ...file.retention },
    digest: { ...DEFAULTS.digest, ...file.digest },
    keys: {
      openai: process.env.OPENAI_API_KEY || file.keys?.openai || '',
      anthropic: process.env.ANTHROPIC_API_KEY || file.keys?.anthropic || '',
    },
  };
  // auto-upgrade: a key present means at least pro features are available
  if (cfg.tier === 'free' && (cfg.keys.openai || cfg.keys.anthropic) && cfg.graph.enabled) cfg.tier = 'pro';
  return cfg;
}

// Turn config into the injected pipeline dependencies.
export function buildDeps(cfg = loadConfig()) {
  let embed;
  switch (cfg.embeddings.provider) {
    case 'openai': embed = openaiEmbedder({ apiKey: cfg.keys.openai, model: cfg.embeddings.model || 'text-embedding-3-small' }); break;
    case 'ollama': embed = ollamaEmbedder({ model: cfg.embeddings.model || 'nomic-embed-text' }); break;
    case 'api':    embed = apiEmbedder({ apiKey: cfg.keys.openai, base: cfg.embeddings.base, model: cfg.embeddings.model }); break;
    default:       embed = localEmbedder();
  }

  let llm = null;
  if (cfg.llm.provider === 'openai') llm = llmClient({ provider: 'openai', apiKey: cfg.keys.openai, model: cfg.llm.model || 'gpt-4o-mini' });
  else if (cfg.llm.provider === 'anthropic') llm = llmClient({ provider: 'anthropic', apiKey: cfg.keys.anthropic, model: cfg.llm.model || 'claude-sonnet-4-6' });
  else if (cfg.llm.provider === 'ollama') llm = ollamaLLM({ model: cfg.llm.model || 'llama3.1' });

  // Graph is a paid capability AND a technical one: it needs a frontier LLM.
  const graphAllowed = cfg.graph.enabled && (cfg.llm.provider === 'openai' || cfg.llm.provider === 'anthropic');
  const graph = graphAllowed ? graphClient(cfg.graph.url) : null;

  return { embed, llm, graph, tier: cfg.tier, graphEnabled: graphAllowed };
}

export function redacted(cfg = loadConfig()) {
  const mask = (k) => (k ? k.slice(0, 6) + '…' : '(unset)');
  return { ...cfg, keys: { openai: mask(cfg.keys.openai), anthropic: mask(cfg.keys.anthropic) } };
}
