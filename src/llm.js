// Central LLM provider resolution. Warden talks to any OpenAI-compatible chat
// API. Point it at one with three env vars:
//
//   LLM_API_KEY     the key for your provider
//   LLM_BASE_URL    the OpenAI-compatible endpoint (optional if LLM_PROVIDER set)
//   LLM_MODEL       the model id (optional; falls back to the provider preset)
//
// Or pick a known provider by name and only supply the key:
//
//   LLM_PROVIDER=groq LLM_API_KEY=gsk_...
//
// Legacy flags (USE_OPENROUTER / USE_OPENAI / USE_LOCAL_LLM / CEREBRAS_API_KEY)
// still work unchanged, so existing setups keep running.
import OpenAI from 'openai';
import { config } from './config.js';
import { settingsStore } from './settings-store.js';

// Known providers: base URL + a sensible default model. `apiKey` is only set
// for endpoints that need a placeholder rather than a real secret (Ollama).
export const PROVIDERS = {
  cerebras:   { baseURL: 'https://api.cerebras.ai/v1',     model: 'qwen-3-235b-a22b-instruct-2507' },
  openai:     { baseURL: 'https://api.openai.com/v1',      model: 'gpt-4o-mini' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1',   model: 'qwen/qwen3-235b-a22b-2507' },
  groq:       { baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  together:   { baseURL: 'https://api.together.xyz/v1',    model: 'Qwen/Qwen2.5-72B-Instruct-Turbo' },
  deepseek:   { baseURL: 'https://api.deepseek.com',       model: 'deepseek-chat' },
  mistral:    { baseURL: 'https://api.mistral.ai/v1',      model: 'mistral-large-latest' },
  xai:        { baseURL: 'https://api.x.ai/v1',            model: 'grok-2-latest' },
  ollama:     { baseURL: 'http://localhost:11434/v1',      model: 'qwen2.5:7b', apiKey: 'ollama' },
};

const DEFAULT_PROVIDER = 'cerebras';

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

// Map the legacy USE_* flags onto the new shape so old .env files keep working.
function legacyProvider() {
  if (process.env.USE_OPENROUTER === '1') {
    return {
      provider: 'openrouter',
      baseURL:  process.env.OPENROUTER_BASE_URL,
      model:    process.env.OPENROUTER_MODEL,
      apiKey:   process.env.OPENROUTER_API_KEY,
    };
  }
  if (process.env.USE_OPENAI === '1') {
    return {
      provider: 'openai',
      baseURL:  process.env.OPENAI_BASE_URL,
      model:    process.env.OPENAI_MODEL,
      apiKey:   process.env.OPENAI_API_KEY,
    };
  }
  if (process.env.USE_LOCAL_LLM === '1') {
    return {
      provider: 'ollama',
      baseURL:  process.env.LOCAL_LLM_BASE_URL,
      model:    process.env.LOCAL_LLM_MODEL,
      apiKey:   'ollama',
    };
  }
  return null;
}

// Resolve the active provider config at call time (so a key set later via the
// dashboard is picked up). Precedence: explicit generic vars > legacy flags >
// provider preset. The key also falls back to the dashboard-stored settings.
export function resolveLLM() {
  const explicit = (process.env.LLM_PROVIDER || '').toLowerCase().trim();
  const legacy   = legacyProvider();
  let providerId = explicit || legacy?.provider || '';
  // No provider named but a custom base URL given: infer the label from its
  // host (so logs/errors are accurate), defaulting to 'custom' if unknown.
  if (!providerId && process.env.LLM_BASE_URL) {
    const host = hostOf(process.env.LLM_BASE_URL);
    providerId = Object.keys(PROVIDERS).find((k) => host && host === hostOf(PROVIDERS[k].baseURL)) || 'custom';
  }
  if (!providerId) providerId = DEFAULT_PROVIDER;
  const preset   = PROVIDERS[providerId] || PROVIDERS[DEFAULT_PROVIDER];

  const baseURL = process.env.LLM_BASE_URL || legacy?.baseURL || preset.baseURL;
  const model   = process.env.LLM_MODEL    || legacy?.model   || preset.model;
  const apiKey  =
       process.env.LLM_API_KEY
    || legacy?.apiKey
    || process.env.CEREBRAS_API_KEY
    || config.cerebrasApiKey
    || settingsStore.get('llmApiKey')
    || settingsStore.get('cerebrasApiKey')
    || preset.apiKey   // placeholder for keyless endpoints (Ollama)
    || null;

  return { provider: providerId, baseURL, model, apiKey };
}

export function hasLLMKey() {
  return Boolean(resolveLLM().apiKey);
}

// Build an OpenAI-compatible client for the resolved provider, or null if no
// key is available.
export function createLLMClient() {
  const { apiKey, baseURL } = resolveLLM();
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL });
}

// OpenAI reasoning models (o-series, gpt-5*) use max_completion_tokens +
// reasoning_effort and reject temperature/top_p. Everything else uses the
// standard chat-completions param shape.
export function isReasoningModel(model = '') {
  return /^(o\d|gpt-5)/i.test(model);
}

// OpenRouter accepts extra routing params (provider sort, reasoning toggle).
export function isOpenRouter(baseURL = '') {
  return /openrouter\.ai/i.test(baseURL);
}
