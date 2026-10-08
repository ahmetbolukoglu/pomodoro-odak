// AppNar factory — runs inside the generated repository's GitHub Actions.
//
//   node appnar/generate.mjs <plan|logic|ui|docs|verify>
//
// Each phase calls a language model, writes files, checks them and commits.
// The AI keys are the repo owner's own (Mistral, Gemini, Groq or OpenRouter,
// tried in that order). They are fetched at run time from AppNar with this
// workflow's GitHub OIDC token, so no secret is stored in the repository.
// An AI_API_KEY repository secret overrides that.
// Zero dependencies; Node 22+.
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_FIX_ROUNDS = 3;

// ───────────────────────────── model access ─────────────────────────────

// `models` are fallbacks only: the live model list is read at start (see
// discoverModels), because providers retire model ids every few months.
const PROVIDERS = {
  // API keys need a paid plan or pay-as-you-go credits (console, Oct 2026).
  mistral: {
    url: 'https://api.mistral.ai/v1/chat/completions',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    maxTokens: 16000,
    extra: {},
    gapMs: 1500,
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    maxTokens: 16000,
    extra: {},
    gapMs: 6500, // free tier: about 10 requests per minute
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    maxTokens: 8000,
    extra: {},
    gapMs: 2500,
  },
  // Free models (":free"); small daily allowance, last resort.
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    models: ['openrouter/free'],
    maxTokens: 12000,
    extra: {},
    gapMs: 3500,
  },
};

// Local models through Ollama on the owner's own computer (AppNar Runner):
// no key, no quota, no cost. Uses Ollama's native API because the
// OpenAI-compatible one cannot raise the context window (num_ctx).
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
PROVIDERS.ollama = {
  url: `${OLLAMA_HOST}/api/chat`,
  native: 'ollama',
  // Preferred coder models, best first; the installed list decides (discoverModels).
  models: ['qwen2.5-coder:32b', 'devstral-small-2:24b', 'gpt-oss:20b', 'qwen2.5-coder:14b', 'qwen2.5-coder:7b'],
  maxTokens: 12000,
  numCtx: 32768,
  extra: {},
  gapMs: 0,
  timeoutMs: 20 * 60_000, // CPU-only machines are slow; one call may take minutes
};

// The AppNar desktop app's own model server (node-llama-cpp, OpenAI-compatible,
// on localhost). The app loads the right model for the machine; any name works.
PROVIDERS.local = {
  url: `${(process.env.APPNAR_LLM_URL || 'http://127.0.0.1:7777').replace(/\/$/, '')}/v1/chat/completions`,
  models: ['local'],
  maxTokens: 8000,
  extra: {},
  gapMs: 0,
  timeoutMs: 45 * 60_000,
  // Tokens arrive as they are produced: no HTTP timeout on long answers, and
  // the owner sees which file is being written (see narrator()).
  stream: true,
};

/** Installed Ollama models in our order of preference (OLLAMA_MODEL wins). */
export function pickOllamaModels(installed, preferred = PROVIDERS.ollama.models, forced = process.env.OLLAMA_MODEL) {
  const names = installed.map((m) => String(m.name ?? m.model ?? '')).filter((n) => n && !/embed/i.test(n));
  if (forced) return names.includes(forced) || names.includes(`${forced}:latest`) ? [forced] : [];
  const base = (n) => n.replace(/:latest$/, '');
  const ranked = preferred.filter((p) => names.some((n) => base(n) === p));
  return ranked.length ? ranked : names.slice(0, 2);
}

/** Gemini first (free, no card); the rest are fallbacks in this order. */
export const PREFERENCE = ['local', 'ollama', 'gemini', 'mistral', 'groq', 'openrouter'];

export function makeProvider(name, key) {
  const def = PROVIDERS[name];
  if (!def) throw new Error(`unknown AI provider "${name}"`);
  if (!key) throw new Error(`no API key for ${name}`);
  return { name, key, ...def, models: [...def.models] };
}

/** "gemini-3.8-flash" → [3, 8]; used to sort model ids newest first. */
function versionOf(id) {
  const m = id.match(/(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0)] : [0, 0];
}

/**
 * Picks the best Gemini text models the key can use, newest Flash first, then
 * Flash-Lite. Skips previews, experiments and image/audio/embedding variants.
 */
export function pickGeminiModels(list) {
  const ok = list
    .filter((m) => (m.supportedGenerationMethods ?? ['generateContent']).includes('generateContent'))
    .map((m) => String(m.name ?? '').replace(/^models\//, ''))
    .filter((id) => /^gemini-[\d.]+-flash(-lite)?$/.test(id));
  const byVersion = (a, b) => {
    const [a1, a2] = versionOf(a);
    const [b1, b2] = versionOf(b);
    return b1 - a1 || b2 - a2;
  };
  const flash = ok.filter((id) => !id.endsWith('-lite')).sort(byVersion);
  const lite = ok.filter((id) => id.endsWith('-lite')).sort(byVersion);
  return [...flash.slice(0, 2), ...lite.slice(0, 1)];
}

/** Free OpenRouter models with room for our prompts, biggest context first. */
export function pickOpenRouterModels(list) {
  return list
    .filter((m) => String(m.id ?? '').endsWith(':free') && (m.context_length ?? 0) >= 32_000)
    .filter((m) => !/vision|image|audio|embed|guard/i.test(m.id))
    .sort((a, b) => (/coder|code/i.test(b.id) ? 1 : 0) - (/coder|code/i.test(a.id) ? 1 : 0) || (b.context_length ?? 0) - (a.context_length ?? 0))
    .slice(0, 3)
    .map((m) => m.id);
}

/** Puts the models this key can actually use first; keeps the static list as a backstop. */
export async function discoverModels(provider, fetcher = fetch) {
  const get = (url, headers = {}) => fetcher(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (provider.name === 'ollama') {
    // Unlike cloud providers, a local setup problem must stop with a clear fix.
    let res;
    try {
      res = await get(`${OLLAMA_HOST}/api/tags`);
    } catch {
      throw new Error(`Ollama is not running at ${OLLAMA_HOST}. Open the Ollama app (or run "ollama serve") and try again.`);
    }
    const live = pickOllamaModels((await res.json()).models ?? []);
    if (!live.length) {
      const forced = process.env.OLLAMA_MODEL ? ` (OLLAMA_MODEL=${process.env.OLLAMA_MODEL} is not installed)` : '';
      throw new Error(`No suitable model in Ollama${forced}. Install one, e.g.: ollama pull qwen2.5-coder:7b`);
    }
    provider.models = live;
    return provider;
  }
  const bearer = { Authorization: `Bearer ${provider.key}` };
  try {
    if (provider.name === 'gemini') {
      const res = await get(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(provider.key)}`);
      if (!res.ok) return provider;
      const live = pickGeminiModels((await res.json()).models ?? []);
      if (live.length) provider.models = [...new Set([...live, ...provider.models])];
    } else if (provider.name === 'groq' || provider.name === 'mistral') {
      const res = await get(provider.name === 'groq' ? 'https://api.groq.com/openai/v1/models' : 'https://api.mistral.ai/v1/models', bearer);
      if (!res.ok) return provider;
      const ids = new Set(((await res.json()).data ?? []).map((m) => m.id));
      const known = provider.models.filter((id) => ids.has(id));
      if (known.length) provider.models = known;
    } else if (provider.name === 'openrouter') {
      const res = await get('https://openrouter.ai/api/v1/models', bearer);
      if (!res.ok) return provider;
      const live = pickOpenRouterModels((await res.json()).data ?? []);
      if (live.length) provider.models = live;
    }
  } catch {
    // Discovery is best effort; the static list still works.
  }
  return provider;
}

// ── providers that ran out of free quota during this workflow run ──
// Each phase is its own process, so this lives in a file in the runner's temp
// dir: once a provider is out, later phases go straight to the next one.

function exhaustedFile(env = process.env) {
  return join(env.RUNNER_TEMP || tmpdir(), `appnar-exhausted-${env.GITHUB_RUN_ID ?? 'local'}.json`);
}

export function exhaustedProviders(env = process.env) {
  try {
    return new Set(JSON.parse(readFileSync(exhaustedFile(env), 'utf8')));
  } catch {
    return new Set();
  }
}

function markExhausted(name, env = process.env) {
  const set = exhaustedProviders(env);
  if (set.has(name)) return;
  set.add(name);
  try {
    writeFileSync(exhaustedFile(env), JSON.stringify([...set]));
  } catch {
    // Not fatal: we just retry it in the next phase.
  }
  console.log(`  ${name}: free quota used up; switching to the next provider for the rest of this run`);
}

/** Preferred order, with providers known to be out of quota moved to the end. */
export function orderProviders(list, exhausted = new Set()) {
  const rank = (p) => (exhausted.has(p.name) ? 100 : 0) + (PREFERENCE.indexOf(p.name) + 1 || 50);
  return [...list].sort((a, b) => rank(a) - rank(b));
}

/**
 * Finds the AI keys: a repo secret first, otherwise ask AppNar with an OIDC
 * token. Returns the primary provider; any others ride along as `fallbacks`.
 */
/** A GitHub Actions OIDC token for AppNar (audience "appnar"). */
async function oidcToken(env, fetcher) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('No OIDC token available: the workflow needs `permissions: id-token: write`.');
  }
  const res = await fetcher(`${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=appnar`, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`could not get an OIDC token: HTTP ${res.status}`);
  return (await res.json()).value;
}

export async function resolveProvider(spec, env = process.env, fetcher = fetch) {
  // AppNar Runner on the owner's computer: local model, no key needed.
  if (env.AI_PROVIDER === 'ollama' || env.AI_PROVIDER === 'local') return makeProvider(env.AI_PROVIDER, 'local');
  if (env.AI_API_KEY) return makeProvider(env.AI_PROVIDER || 'gemini', env.AI_API_KEY);
  if (env.GEMINI_API_KEY) return makeProvider('gemini', env.GEMINI_API_KEY);
  if (!spec.keyEndpoint) throw new Error('No AI key: set an AI_API_KEY repository secret or rebuild from AppNar.');
  const value = await oidcToken(env, fetcher);
  const res = await fetcher(spec.keyEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${value}` } });
  if (res.status === 404) {
    throw new Error('Your AppNar account has no AI key yet. Add one in AppNar → Settings → AI, then press "Rebuild".');
  }
  if (!res.ok) throw new Error(`AppNar key service answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const keys = Array.isArray(body.keys) && body.keys.length ? body.keys : [{ provider: body.provider, apiKey: body.apiKey }];
  if (env.GITHUB_ACTIONS) for (const k of keys) console.log(`::add-mask::${k.apiKey}`);
  const known = keys.filter((k) => PROVIDERS[k.provider]).map((k) => makeProvider(k.provider, k.apiKey));
  if (!known.length) throw new Error(`No supported AI provider among: ${keys.map((k) => k.provider).join(', ')}`);
  const [primary, ...rest] = orderProviders(known, exhaustedProviders(env));
  return { ...primary, fallbacks: rest };
}

// ── usage of the free allowances, reported to AppNar after each phase ──

const usage = new Map();

/** Counts one HTTP call to a provider and keeps its rate-limit headers, if any. */
function track(provider, res, data) {
  const u = usage.get(provider) ?? { provider, requests: 0, tokens: 0, quotaHits: 0, limits: null };
  u.requests++;
  if (res.status === 429) u.quotaHits++;
  // OpenAI-style `usage`, or Ollama's prompt_eval_count / eval_count.
  const t = data?.usage ?? (data?.eval_count !== undefined ? { prompt_tokens: data.prompt_eval_count ?? 0, completion_tokens: data.eval_count } : null);
  if (t) u.tokens += Number(t.total_tokens ?? (t.prompt_tokens ?? 0) + (t.completion_tokens ?? 0)) || 0;
  const limits = {};
  for (const [k, v] of res.headers) {
    if (/ratelimit/i.test(k) && Object.keys(limits).length < 12) limits[k.toLowerCase()] = v.slice(0, 40);
  }
  if (Object.keys(limits).length) u.limits = limits;
  usage.set(provider, u);
}

/** Forgets counted usage (each test starts clean). */
export function resetUsage() {
  usage.clear();
}

export function usageEvents() {
  return [...usage.values()];
}

/** Best effort: a reporting problem must never fail a build. */
export async function reportUsage(spec, env = process.env, fetcher = fetch) {
  const events = usageEvents();
  // Only GitHub Actions runs can report (OIDC); local builds have nothing to report.
  if (!events.length || !spec.keyEndpoint || env.AI_API_KEY || !env.ACTIONS_ID_TOKEN_REQUEST_URL) return;
  try {
    const value = await oidcToken(env, fetcher);
    const res = await fetcher(spec.keyEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usage: events }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) usage.clear();
    console.log(`  usage: ${events.map((e) => `${e.provider} ${e.requests} req / ${e.tokens} tok`).join(', ')}`);
  } catch (e) {
    console.log(`  usage report skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// APPNAR_NO_WAIT=1 skips the polite pauses (tests).
const sleep = (ms) => new Promise((r) => setTimeout(r, process.env.APPNAR_NO_WAIT ? 0 : ms));

/** Polite pause between calls so free-tier rate limits are not hit. */
const pause = (provider) => sleep(provider.gapMs ?? 4000);

/** A 429 that will not clear by waiting: the daily/monthly free quota is used up. */
export function isDailyQuota(body) {
  return /PerDay|per day|daily|per month|monthly|quota exceeded|insufficient_quota|tokens per day|requests per day/i.test(body);
}

/** The request alone exceeds a per-request/per-minute token cap (e.g. Groq's 8K TPM). */
export function isTooLarge(body) {
  return /request too large|too many tokens|context length|maximum context|reduce (the|your) (length|message|prompt)|Requested d+.*Limit d+/i.test(body);
}

/** Seconds the provider asks us to wait ("retry-after" header or Gemini's retryDelay). */
function retryAfter(res, body, attempt) {
  const header = Number(res.headers.get('retry-after'));
  if (header > 0) return header;
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1]));
  return 15 * (attempt + 1);
}

/**
 * One chat completion. Retries short rate limits, then falls back across the
 * provider's models and finally across fallback providers (e.g. Gemini → Groq).
 */
/** Request body in the provider's dialect: OpenAI chat completions, or Ollama's /api/chat. */
export function requestBody(p, model, system, user, jsonMode, plain) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  if (p.native === 'ollama') {
    return {
      model,
      messages,
      stream: false,
      ...(jsonMode ? { format: 'json' } : {}),
      options: { temperature: 0.4, num_ctx: p.numCtx ?? 32768, num_predict: p.maxTokens },
    };
  }
  return {
    model,
    temperature: 0.4,
    max_tokens: p.maxTokens,
    ...(plain ? {} : (p.extra ?? {})),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(p.stream ? { stream: true } : {}),
    messages,
  };
}

/**
 * Reads an OpenAI-style server-sent event stream into the full answer. An
 * error event inside the stream throws with `.status`.
 */
export async function readEventStream(res, onText = () => {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let finish = null;
  let usage = null;
  const take = (chunk) => {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw Object.assign(new Error(j.error.message ?? 'stream error'), { status: j.error.status ?? 500 });
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onText(text);
      }
      if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
      if (j.usage) usage = j.usage;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      take(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) take(buf);
  return { text, finish, usage };
}

/**
 * Narrates a streamed answer for the owner: which file is being written and,
 * every few seconds, how far along it is ("  » write: src/app.js",
 * "  » progress: src/app.js · 120 lines").
 */
export function narrator({ log = (l) => console.log(l), everyMs = 10_000, now = Date.now } = {}) {
  let file = null;
  let last = now();
  let lastLines = 0;
  return (text) => {
    const marks = [...text.matchAll(/^=== FILE: (.+?) ===\s*$/gm)];
    const mark = marks.at(-1);
    const current = mark ? mark[1].trim() : null;
    if (current && current !== file) {
      file = current;
      last = now();
      lastLines = 0;
      log(`  » write: ${file}`);
      return;
    }
    if (now() - last < everyMs) return;
    last = now();
    const body = mark ? text.slice(mark.index + mark[0].length) : text;
    const lines = body.trim() ? body.trim().split('\n').length : 0;
    if (lines !== lastLines) {
      lastLines = lines;
      log(`  » progress: ${current ?? 'answer'} · ${lines} lines`);
    }
  };
}

export async function chat(provider, system, user, { json = false, fetcher = fetch } = {}) {
  // Providers that ran out earlier in this run go last.
  const chain = orderProviders([provider, ...(provider.fallbacks ?? [])], exhaustedProviders());
  const errors = [];
  for (const p of chain) {
    let rejected = false;
    let quotaHits = 0; // models of this provider that ended on a rate/quota limit
    const hasNext = chain.indexOf(p) < chain.length - 1;
    const models = [...p.models];
    models: for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      // Optional parameters (JSON mode, provider extras) are dropped once if the
      // provider chokes on them; plain chat completions are the most compatible.
      let plain = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        let res;
        try {
          res = await fetcher(p.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${p.key}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(p.timeoutMs ?? 180_000),
            body: JSON.stringify(requestBody(p, model, system, user, json && !plain, plain)),
          });
        } catch (e) {
          // Network drop or timeout: same treatment as a 5xx.
          errors.push(`${p.name}/${model}: network error: ${e instanceof Error ? (e.cause?.message ?? e.message) : String(e)}`);
          console.log(`  ${errors.at(-1)}`);
          if (attempt === 3) break;
          await sleep(10_000 * (attempt + 1));
          continue;
        }
        if (p.stream && res.ok && /event-stream/.test(res.headers.get('content-type') ?? '')) {
          try {
            const out = await readEventStream(res, narrator());
            if (out.text.trim()) {
              if (p !== provider) console.log(`  answered by fallback ${p.name}/${model}`);
              return out.text;
            }
            errors.push(`${p.name}/${model}: empty response (finish_reason: ${out.finish ?? 'unknown'})`);
            break;
          } catch (e) {
            const status = e?.status;
            errors.push(`${p.name}/${model}: ${status === 413 ? 'HTTP 413 ' : ''}stream error: ${e instanceof Error ? (e.cause?.message ?? e.message) : String(e)}`);
            console.log(`  ${errors.at(-1)}`);
            if (status === 413) break; // the prompt does not fit; retrying will not help
            if (attempt === 3) break;
            await sleep(10_000 * (attempt + 1));
            continue;
          }
        }
        const body = await res.text().catch(() => '');
        let usageData = null;
        try {
          usageData = res.ok ? JSON.parse(body) : null;
        } catch {
          // reported as "not JSON" below
        }
        track(p.name, res, usageData);
        if (res.ok) {
          let data = null;
          try {
            data = JSON.parse(body);
          } catch {
            errors.push(`${p.name}/${model}: response is not JSON: ${body.slice(0, 120)}`);
            break;
          }
          const text = p.native === 'ollama' ? data?.message?.content : data?.choices?.[0]?.message?.content;
          if (typeof text === 'string' && text.trim()) {
            if (p !== provider) console.log(`  answered by fallback ${p.name}/${model}`);
            return text;
          }
          errors.push(`${p.name}/${model}: empty response (finish_reason: ${data?.choices?.[0]?.finish_reason ?? data?.done_reason ?? 'unknown'})`);
          break;
        }
        errors.push(`${p.name}/${model}: HTTP ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
        console.log(`  ${errors.at(-1)}`);
        if (res.status === 401 || res.status === 403) {
          rejected = true;
          break models; // a bad key fails every model of this provider
        }
        if (res.status === 413 || isTooLarge(body)) {
          console.log(`  ${p.name}/${model}: request too large for this model's free limits; trying the next option`);
          break;
        }
        if (res.status === 429 && isDailyQuota(body)) {
          quotaHits++;
          console.log(`  ${p.name}/${model}: daily free quota used up; trying the next option`);
          break; // waiting will not help today
        }
        if (res.status === 429 && hasNext && attempt >= 1) {
          quotaHits++;
          break; // another provider is waiting; don't burn minutes on this one
        }
        if (res.status === 404) {
          // Retired model: providers usually name the replacement ("use models/x instead").
          const suggested = body
            .match(/models\/[\w.-]+/g)
            ?.map((s) => s.slice('models/'.length).replace(/\.+$/, ''))
            .find((id) => id !== model && !models.includes(id));
          if (suggested) {
            console.log(`  ${p.name}/${model} is retired; trying ${suggested}`);
            models.splice(mi + 1, 0, suggested);
          }
          break;
        }
        if (!plain && (res.status === 400 || res.status === 500)) {
          plain = true;
          console.log(`  ${p.name}/${model}: retrying without optional parameters`);
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          if (attempt === 3) {
            if (res.status === 429) quotaHits++;
            break;
          }
          const wait = Math.min(retryAfter(res, body, attempt), 45);
          console.log(`  ${p.name}/${model}: HTTP ${res.status}; retrying in ${wait}s`);
          await sleep(wait * 1000);
          continue;
        }
        break; // other 4xx (e.g. unknown model): try the next model
      }
    }
    if (rejected) console.log(`  ${p.name}: the key was rejected`);
    if (quotaHits > 0 && quotaHits >= models.length) markExhausted(p.name);
  }
  const all = errors.join('\n');
  if (errors.every((e) => / HTTP 40[13] /.test(e))) {
    throw new Error(`The AI key was rejected. Check it in AppNar → Settings → AI.\n${all}`);
  }
  if (/HTTP 429/.test(all)) {
    throw new Error(`The free AI quota is used up for now. Add another free key (e.g. Groq) as a fallback in AppNar → Settings → AI, or try again later.\n${all}`);
  }
  throw new Error(`Model call failed:\n${all}`);
}

// ───────────────────────────── parsing helpers ─────────────────────────────

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };

/**
 * The file content inside whatever the model wrapped it in. Local models in
 * particular add a ``` fence, a sentence before/after it, or <code>/<pre>
 * tags (seen in a real build: tests/logic.test.js started with "<code>").
 * Markdown keeps inner fences (only a fence around the whole text goes);
 * HTML keeps its tags.
 */
export function stripFence(text, path = '') {
  let t = text.trim();
  const whole = t.match(/^```[\w.-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  if (whole) t = whole[1];
  else if (!/\.md$/i.test(path)) {
    // Prose around a single fenced block: keep the block.
    const blocks = [...t.matchAll(/^```[\w.-]*[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)];
    if (blocks.length === 1) t = blocks[0][1];
  }
  if (!/\.(md|html?)$/i.test(path)) {
    // <pre><code>…</code></pre> around the whole file, escaped like HTML.
    const tag = t.trim().match(/^<(pre|code)\b[^>]*>\s*(?:<code\b[^>]*>)?([\s\S]*?)(?:<\/code>\s*)?<\/(?:pre|code)>$/i);
    if (tag) t = tag[2].replace(/&(lt|gt|amp|quot|#39|#x27);/g, (e) => ENTITIES[e]);
    else t = t.replace(/^\s*<(pre|code)\b[^>]*>\s*/i, '').replace(/\s*<\/(pre|code)>\s*$/i, '');
  }
  return t.trim() + '\n';
}

/** Parses "=== FILE: path ===" blocks. Unknown paths are ignored. */
export function parseFiles(text, allowed) {
  const out = {};
  const re = /^=== FILE: (.+?) ===\s*$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const path = m[1].trim();
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(m.index + m[0].length, end);
    if (allowed.includes(path)) out[path] = stripFence(body, path);
  });
  return out;
}

export function parseJson(text) {
  const t = text.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model did not return JSON');
  return JSON.parse(t.slice(start, end + 1));
}

/** Names imported from ./logic.js by the UI module. */
export function importedNames(appJs) {
  const names = new Set();
  for (const m of appJs.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/logic\.js['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

const definedIds = (html) => new Set([...html.matchAll(/\sid=["']([\w-]+)["']/g)].map((m) => m[1]));

/** Names of one-line wrappers such as `const $ = (id) => document.getElementById(id)`. */
export function idHelpers(appJs) {
  const names = new Set();
  const arrow = /(?:const|let|var)\s+([\w$]+)\s*=\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*(?:return\s+)?document\.getElementById\(\s*\2\s*\)/g;
  const fn = /function\s+([\w$]+)\s*\(\s*([\w$]+)\s*\)\s*\{\s*return\s+document\.getElementById\(\s*\2\s*\)/g;
  for (const m of appJs.matchAll(arrow)) names.add(m[1]);
  for (const m of appJs.matchAll(fn)) names.add(m[1]);
  return [...names];
}

/** Element ids the script looks up that the HTML does not define (incl. via `$('id')` helpers). */
export function missingIds(appJs, html) {
  const defined = definedIds(html);
  const used = new Set();
  for (const m of appJs.matchAll(/getElementById\(\s*['"]([\w-]+)['"]\s*\)/g)) used.add(m[1]);
  for (const m of appJs.matchAll(/querySelector(?:All)?\(\s*['"]#([\w-]+)['"]\s*\)/g)) used.add(m[1]);
  for (const name of idHelpers(appJs)) {
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(\\s*['"]([\\w-]+)['"]\\s*\\)`, 'g');
    for (const m of appJs.matchAll(call)) used.add(m[1]);
  }
  // Ids the script creates itself (in template strings) are not missing.
  const created = new Set([...appJs.matchAll(/\sid=["'`]([\w-]+)["'`]/g)].map((m) => m[1]));
  return [...used].filter((id) => !defined.has(id) && !created.has(id));
}

/** Buttons with an id in the HTML that the script never mentions (so nothing can be listening). */
export function unwiredButtons(appJs, html) {
  const out = [];
  for (const m of html.matchAll(/<button\b([^>]*)>/gi)) {
    const attrs = m[1];
    const id = attrs.match(/\sid=["']([\w-]+)["']/)?.[1];
    if (!id) continue;
    if (/\stype=["']submit["']/i.test(attrs) || !/\stype=/i.test(attrs)) {
      // A form submit button works through the form's submit handler.
      const before = html.slice(0, m.index);
      const formOpen = before.lastIndexOf('<form');
      if (formOpen > before.lastIndexOf('</form')) continue;
    }
    if (!new RegExp(`['"\`#]${id}['"\`\\]]`).test(appJs)) out.push(id);
  }
  return out;
}

export function exportedNamesFromSource(logicJs) {
  const names = new Set();
  for (const m of logicJs.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of logicJs.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (alias) names.add(alias);
    }
  }
  return [...names];
}

// ───────────────────────────── io helpers ─────────────────────────────

async function readText(path) {
  return existsSync(path) ? readFile(path, 'utf8') : '';
}

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function git(...args) {
  execFileSync('git', args, { stdio: 'inherit' });
}

/** One commit with `paths` on top of the branch tip, through the GitHub REST API. */
export async function commitViaApi(message, paths, env = process.env, fetcher = fetch) {
  const repo = env.GITHUB_REPOSITORY;
  const branch = env.APPNAR_BRANCH || 'main';
  const gh = async (method, path, body) => {
    const res = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.APPNAR_GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`), { status: res.status, body: text });
    return text ? JSON.parse(text) : null;
  };
  const files = [];
  for (const p of paths) if (existsSync(p)) files.push({ path: p.replace(/\\/g, '/'), mode: '100644', type: 'blob', content: await readFile(p, 'utf8') });
  if (!files.length) return console.log(`  nothing to commit for "${message}"`);
  for (let attempt = 1; ; attempt++) {
    const ref = await gh('GET', `/git/ref/heads/${branch}`);
    const parent = await gh('GET', `/git/commits/${ref.object.sha}`);
    const tree = await gh('POST', '/git/trees', { base_tree: parent.tree.sha, tree: files });
    if (tree.sha === parent.tree.sha) return console.log(`  nothing to commit for "${message}"`);
    const author = env.APPNAR_AUTHOR_NAME ? { name: env.APPNAR_AUTHOR_NAME, email: env.APPNAR_AUTHOR_EMAIL || 'appnar@users.noreply.github.com', date: new Date().toISOString() } : undefined;
    const created = await gh('POST', '/git/commits', { message, tree: tree.sha, parents: [ref.object.sha], ...(author ? { author, committer: author } : {}) });
    try {
      await gh('PATCH', `/git/refs/heads/${branch}`, { sha: created.sha, force: false });
      console.log(`  committed "${message}" (${created.sha.slice(0, 7)})`);
      return;
    } catch (e) {
      // Someone pushed in between (e.g. a spec change): rebuild on the new tip.
      if (!(e.status === 422 && /fast forward/i.test(e.body ?? '')) || attempt >= 3) throw e;
    }
  }
}

/**
 * Commits and pushes `paths`. In GitHub Actions (and the CLI Runner) this is
 * plain git; the desktop app sets APPNAR_GITHUB_TOKEN instead, so users need
 * no git install and the commit goes through GitHub's Git Data API.
 */
async function commit(message, paths) {
  if (process.env.APPNAR_GITHUB_TOKEN) return commitViaApi(message, paths);
  git('add', '--', ...paths);
  const staged = spawnSync('git', ['diff', '--cached', '--quiet']);
  if (staged.status === 0) {
    console.log(`  nothing to commit for "${message}"`);
    return;
  }
  git('commit', '-m', message);
  git('push', 'origin', 'HEAD');
}

function runTests() {
  say('run', 'unit tests (node --test)');
  // A parent test runner's context would swallow the child's exit code.
  const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', 'tests/*.test.js'], { encoding: 'utf8', timeout: 120_000, env });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

function checkSyntax(path) {
  const r = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || r.stdout || 'syntax error').slice(0, 1500);
}

const tail = (s, n) => (s.length > n ? `…${s.slice(-n)}` : s);

/**
 * One line of narration for the owner (the desktop studio shows these as
 * "what I am doing now"): "  » <kind>: <detail>".
 */
export function say(kind, detail) {
  console.log(`  » ${kind}: ${detail}`);
}

/** The first real error line of a test run, e.g. "SyntaxError: Unexpected token '<'". */
export function firstError(output) {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^[\w.]*(Error|Exception)( \[[\w_]+\])?:/.test(l));
  return line ? line.slice(0, 200) : null;
}

// ───────────────────────────── prompts ─────────────────────────────

const LANG = { tr: 'Turkish', en: 'English' };

function rules(spec) {
  return `You are a senior front-end engineer building a small, polished, production-quality web app.
Hard rules:
- Plain HTML, CSS and JavaScript ES modules. No frameworks, no build step, no CDN, no external requests.
- Data persists in localStorage. Everything works offline.
- All user-facing text is in ${LANG[spec.language] ?? 'English'}. Code identifiers and comments are in English.
- Accessible: semantic HTML, labels for inputs, visible focus, keyboard usable, sufficient contrast.
- Responsive from 360px phones to desktops. Supports light and dark (prefers-color-scheme).
- Brand accent color: ${spec.accent || '#39d353'}.`;
}

function specBlock(spec, plan) {
  return `App request:
- Name: ${spec.name}
- Category: ${spec.category}
- Description: ${spec.description}
- Requested features: ${(spec.features ?? []).join('; ') || '(choose sensible ones)'}
${plan ? `\nPlan:\n${JSON.stringify(plan, null, 1)}` : ''}`;
}

// ───────────────────────────── phases ─────────────────────────────

async function loadSpec() {
  const spec = JSON.parse(await readFile('appnar/spec.json', 'utf8'));
  if (!spec.name || !spec.description) throw new Error('appnar/spec.json needs name and description');
  return spec;
}

async function loadPlan() {
  return JSON.parse(await readFile('appnar/plan.json', 'utf8'));
}

async function phasePlan(provider, spec) {
  if (isChange(spec)) {
    console.log(`  change request #${spec.revision}: keeping the existing plan`);
    console.log(changeBlock(spec));
    return;
  }
  say('think', 'planning features, data model and test cases');
  const text = await chat(
    provider,
    `${rules(spec)}\nYou are planning the app. Answer with one JSON object only.`,
    `${specBlock(spec)}

Return JSON with exactly these keys:
{
  "title": "display name",
  "tagline": "one sentence value proposition",
  "features": ["5 to 7 concrete user-facing features"],
  "data_model": "short description of the stored records and fields",
  "screens": ["main UI regions, top to bottom"],
  "logic_api": [{"name": "camelCaseFunction", "signature": "(args) => result", "purpose": "what it does"}],
  "test_cases": ["8 to 12 behaviours the unit tests must check"]
}
logic_api lists 6 to 12 PURE functions (no DOM, no storage, no Date.now inside; pass time in) that hold all business rules: validation, create/update/delete on arrays of records, filtering, sorting, totals, statistics, import/export, etc.`,
    { json: true },
  );
  const plan = parseJson(text);
  if (!Array.isArray(plan.logic_api) || plan.logic_api.length === 0) throw new Error('plan has no logic_api');
  await write('appnar/plan.json', `${JSON.stringify(plan, null, 2)}\n`);

  const md = `# ${plan.title}

> ${plan.tagline}

## Features
${plan.features.map((f) => `- ${f}`).join('\n')}

## Data model
${plan.data_model}

## Screens
${plan.screens.map((s) => `- ${s}`).join('\n')}

## Core logic (\`src/logic.js\`)
| Function | Signature | Purpose |
|---|---|---|
${plan.logic_api.map((f) => `| \`${f.name}\` | \`${f.signature}\` | ${f.purpose} |`).join('\n')}

## Test plan
${plan.test_cases.map((t) => `- [ ] ${t}`).join('\n')}
`;
  await write('docs/PLAN.md', md);
  await commit('docs: add product plan', ['docs/PLAN.md', 'appnar/plan.json']);
}

const LOGIC_FILES = ['src/logic.js', 'tests/logic.test.js'];
const LOGIC_FORMAT = `Answer with exactly two blocks and nothing else:
=== FILE: src/logic.js ===
(full file content here: raw code only, no markdown fences, no <code> or <pre> tags)
=== FILE: tests/logic.test.js ===
(full file content here: raw code only, no markdown fences, no <code> or <pre> tags)`;

/** Runs the unit tests and lets the model fix code or tests until they pass. */
async function testAndFix(provider, spec, files) {
  let result = runTests();
  for (let round = 1; !result.ok && round <= MAX_FIX_ROUNDS; round++) {
    const testsOnly = round === MAX_FIX_ROUNDS;
    console.log(`  tests failed; fix round ${round}${testsOnly ? ' (tests only)' : ''}`);
    await pause(provider);
    say('read', 'src/logic.js, tests/logic.test.js and the test output');
    say('think', testsOnly ? 'fixing the tests to match the code' : 'finding the bug in the code or the tests');
    const fixed = await chat(
      provider,
      rules(spec),
      `The unit tests fail. ${testsOnly ? 'Assume src/logic.js is correct and fix ONLY the tests so they match its documented behaviour.' : 'Fix the bug, in the code or in a wrong test.'}

=== FILE: src/logic.js ===
${files['src/logic.js']}
=== FILE: tests/logic.test.js ===
${files['tests/logic.test.js']}

Test output:
${tail(result.output, 3500)}

${LOGIC_FORMAT}`,
    );
    const next = parseFiles(fixed, LOGIC_FILES);
    if (testsOnly) delete next['src/logic.js'];
    Object.assign(files, next);
    for (const f of LOGIC_FILES) await write(f, files[f]);
    result = runTests();
  }
  if (!result.ok) {
    console.error(tail(result.output, 4000));
    const cause = firstError(result.output);
    throw new Error(`unit tests still fail after fix rounds${cause ? ` (${cause})` : ''}`);
  }
  const counts = result.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(#|ℹ) (tests|pass|fail) \d+/.test(l))
    .map((l) => l.slice(2));
  console.log(`  tests passed: ${counts.join(', ') || 'ok'}`);
}

async function phaseLogic(provider, spec) {
  if (isChange(spec)) return changeLogic(provider, spec);
  const plan = await loadPlan();
  say('read', 'docs/PLAN.md (features, logic API, test plan)');
  const first = await chat(
    provider,
    rules(spec),
    `${specBlock(spec, plan)}

Write:
1. src/logic.js — an ES module exporting every function in plan.logic_api (same names). Pure functions only: no DOM, no localStorage, no Date.now()/Math.random() inside (accept them as parameters). Never mutate inputs; return new arrays/objects. Validate inputs and throw Error with a clear message on invalid data. Under 180 lines.
2. tests/logic.test.js — tests using only "node:test" and "node:assert/strict", importing from "../src/logic.js". Cover plan.test_cases, including edge cases. Under 140 lines.

${LOGIC_FORMAT}`,
  );
  const files = parseFiles(first, LOGIC_FILES);
  for (const f of LOGIC_FILES) if (!files[f]) throw new Error(`model did not return ${f}`);
  for (const f of LOGIC_FILES) await write(f, files[f]);
  await testAndFix(provider, spec, files);
  await commit('feat: core logic with unit tests', LOGIC_FILES);
}

const UI_RULES = `UI wiring rules (these are checked automatically by clicking every button in a real browser):
- Every button and control in index.html must do something visible when used: open/close a panel, change the list, show a message, download, etc.
- Every element the script looks up must exist in index.html with exactly that id. Do NOT hide a missing element behind \`if (el)\` or \`?.\` — make the ids match instead.
- Buttons inside a <form> that are not meant to submit it need type="button".
- Show/hide with the \`hidden\` attribute or one consistent CSS class that exists in styles.css.`;

/** Static checks plus a real-browser click test. `fatal` problems stop the build. */
async function checkUi(exported) {
  say('run', 'opening the app in a real browser and clicking every button');
  const html = await readText('index.html');
  const appJs = await readText('src/app.js');
  const fatal = [];
  const issues = [];
  const syntax = checkSyntax('src/app.js');
  if (syntax) fatal.push(`Syntax error in src/app.js:\n${syntax}`);
  const unknown = importedNames(appJs).filter((n) => !exported.includes(n));
  if (unknown.length) fatal.push(`src/app.js imports names that src/logic.js does not export: ${unknown.join(', ')}`);
  const missing = missingIds(appJs, html);
  if (missing.length) issues.push(`src/app.js looks up ids that index.html does not have: ${missing.map((i) => `#${i}`).join(', ')}`);
  const unwired = unwiredButtons(appJs, html);
  if (unwired.length) issues.push(`Buttons in index.html that src/app.js never wires up: ${unwired.map((i) => `#${i}`).join(', ')}`);
  let smoke = null;
  if (!fatal.length) {
    const { smokeTest, describeSmoke } = await import('./smoke.mjs');
    smoke = await smokeTest('.').catch((e) => ({ skipped: String(e), loadErrors: [], clickErrors: [], deadButtons: [], checked: 0 }));
    if (smoke.skipped) console.log(`  browser check skipped: ${smoke.skipped}`);
    else console.log(`  browser check: ${smoke.checked} buttons clicked`);
    issues.push(...describeSmoke(smoke));
  }
  return { fatal, issues, smoke };
}

/**
 * Checks the UI and lets the model repair it for a few rounds. Whatever is left
 * is written to appnar/report.json so AppNar can show it and offer a fix.
 */
async function refineUi(provider, spec, exported, api) {
  let check = await checkUi(exported);
  for (let round = 1; round <= MAX_FIX_ROUNDS && (check.fatal.length || check.issues.length); round++) {
    const problems = [...check.fatal, ...check.issues];
    console.log(`  UI problems; fix round ${round}:\n    ${problems.join('\n    ')}`);
    await pause(provider);
    say('read', 'index.html, src/app.js and the browser check results');
    say('think', `fixing ${problems.length} UI problem(s)`);
    const reply = await chat(
      provider,
      rules(spec),
      `${specBlock(spec)}

Automated checks found these problems in the app's UI:
${problems.map((p) => `- ${p}`).join('\n')}

${UI_RULES}

src/logic.js exports: ${exported.join(', ')}
${api ? `Logic API:\n${api}\n` : ''}
=== FILE: index.html ===
${await readText('index.html')}
=== FILE: src/app.js ===
${await readText('src/app.js')}

Fix every problem without removing features. Return src/app.js in full, and index.html in full only if you changed it:
=== FILE: src/app.js ===
(full file content here: raw code only, no markdown fences, no <code> or <pre> tags)
=== FILE: index.html ===
(full file content, raw code only; or omit this block)`,
    );
    const files = parseFiles(reply, ['src/app.js', 'index.html']);
    if (!files['src/app.js'] && !files['index.html']) break;
    for (const [path, content] of Object.entries(files)) await write(path, content);
    check = await checkUi(exported);
  }
  if (check.fatal.length) throw new Error(`src/app.js still has problems:\n${check.fatal.join('\n')}`);
  await write(
    'appnar/report.json',
    `${JSON.stringify(
      {
        revision: spec.revision,
        checkedAt: new Date().toISOString(),
        browserCheck: check.smoke ? (check.smoke.skipped ? `skipped: ${check.smoke.skipped}` : `${check.smoke.checked} buttons clicked`) : 'not run',
        issues: check.issues,
      },
      null,
      2,
    )}\n`,
  );
  if (check.issues.length) console.log(`::warning title=AppNar UI check::${check.issues.length} issue(s) left; see appnar/report.json`);
  return check;
}

async function phaseUi(provider, spec) {
  if (isChange(spec)) return changeUi(provider, spec);
  const plan = await loadPlan();
  const logic = await readFile('src/logic.js', 'utf8');
  const exported = exportedNamesFromSource(logic);
  const api = plan.logic_api.map((f) => `${f.name}${f.signature.startsWith('(') ? f.signature : `: ${f.signature}`} — ${f.purpose}`).join('\n');

  say('read', 'docs/PLAN.md and the exports of src/logic.js');
  say('think', 'designing the screen layout and styles');
  // 1) Markup and styles.
  const shell = await chat(
    provider,
    rules(spec),
    `${specBlock(spec, plan)}

Write the markup and styles.
- index.html: complete document, lang attribute, <meta name="viewport">, <title>, <link rel="stylesheet" href="styles.css">, and <script type="module" src="src/app.js"></script>. Give every element the script will touch a unique, descriptive id. Include an empty state, a form for creating records, the list/board/table area, and a footer line "Built with AppNar".
- Only add buttons for features the app really has; each one will be wired up.
- styles.css: modern, clean design system with CSS custom properties, light and dark themes, comfortable spacing, rounded cards, subtle shadows, hover/focus states, smooth but reduced-motion-aware transitions, mobile-first responsive layout. Include a \`[hidden] { display: none !important; }\` rule. Under 260 lines.

Answer with exactly two blocks:
=== FILE: index.html ===
(full file content here: raw code only, no markdown fences, no <code> or <pre> tags)
=== FILE: styles.css ===
(full file content here: raw code only, no markdown fences, no <code> or <pre> tags)`,
  );
  const sf = parseFiles(shell, ['index.html', 'styles.css']);
  if (!sf['index.html'] || !sf['styles.css']) throw new Error('model did not return index.html and styles.css');
  await write('index.html', sf['index.html']);
  await write('styles.css', sf['styles.css']);
  await pause(provider);

  say('think', 'wiring buttons and forms to the business logic');
  // 2) Behaviour, written against the real markup and logic exports.
  const appJs = stripFence(
    await chat(
      provider,
      rules(spec),
      `${specBlock(spec, plan)}

Write src/app.js: the ES module that wires the UI.
- import { ... } from './logic.js' — available exports: ${exported.join(', ')}
- Logic API:
${api}
- This is index.html; use exactly these ids:
${tail(sf['index.html'], 6000)}
- Load/save state in localStorage under the key "${spec.slug || 'app'}:v1" with try/catch; render from state; event delegation for lists; show friendly validation messages; confirm before destructive actions.

${UI_RULES}

Under 260 lines. Output only the JavaScript code.`,
    ),
  );
  await write('src/app.js', appJs);

  // 3) Check in a real browser and repair.
  await refineUi(provider, spec, exported, api);
  await commit('feat: user interface', ['index.html', 'styles.css', 'src/app.js', 'appnar/report.json']);
}

// ───────────────────────────── change requests ─────────────────────────────
// A spec with `change` asks to fix or adjust an app that already exists,
// instead of building it again from scratch.

function isChange(spec) {
  return Boolean(spec.change?.text || spec.change?.issues?.length) && existsSync('src/app.js');
}

function changeBlock(spec) {
  const c = spec.change ?? {};
  return `The owner asked for this change:
${c.text ? `"""${c.text}"""` : '(no free-text request)'}
${c.issues?.length ? `\nProblems found by automated checks that must also be fixed:\n${c.issues.map((i) => `- ${i}`).join('\n')}` : ''}`;
}

/** One-line commit subject from the owner's request. */
function changeSubject(spec) {
  const text = (spec.change?.text || 'fix issues found by automated checks').replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

async function changeLogic(provider, spec) {
  const files = { 'src/logic.js': await readText('src/logic.js'), 'tests/logic.test.js': await readText('tests/logic.test.js') };
  say('read', 'src/logic.js and tests/logic.test.js');
  say('think', 'checking whether the request changes the business rules');
  const reply = await chat(
    provider,
    rules(spec),
    `${specBlock(spec)}

${changeBlock(spec)}

These are the app's pure business rules and their tests:
=== FILE: src/logic.js ===
${files['src/logic.js']}
=== FILE: tests/logic.test.js ===
${files['tests/logic.test.js']}

Does the change need different business rules (not just UI wiring or looks)?
If NO, answer exactly: NO_CHANGE
If YES, keep every existing export, add or adjust what is needed, cover it with tests, and answer with:
${LOGIC_FORMAT}`,
  );
  if (/^\s*NO_CHANGE\s*$/m.test(reply) && !reply.includes('=== FILE:')) {
    console.log('  business rules unchanged');
    return;
  }
  Object.assign(files, parseFiles(reply, LOGIC_FILES));
  for (const f of LOGIC_FILES) await write(f, files[f]);
  await testAndFix(provider, spec, files);
  await commit(`fix: logic for ${changeSubject(spec)}`, LOGIC_FILES);
}

async function changeUi(provider, spec) {
  const exported = exportedNamesFromSource(await readText('src/logic.js'));
  const wantsLooks = /renk|tema|tasar[ıi]m|g[öo]r[üu]n[üu]m|font|yaz[ıi] tipi|bo[şs]luk|mobil|koyu|a[çc][ıi]k|css|style|colou?r|theme|design|look|layout|spacing|dark|light|responsive/i.test(spec.change?.text ?? '');
  say('read', `index.html, src/app.js${wantsLooks ? ', styles.css' : ''}`);
  say('think', 'making the requested change with the smallest edits');
  const reply = await chat(
    provider,
    rules(spec),
    `${specBlock(spec)}

${changeBlock(spec)}

${UI_RULES}

src/logic.js exports: ${exported.join(', ')}

=== FILE: index.html ===
${await readText('index.html')}
=== FILE: src/app.js ===
${await readText('src/app.js')}
${wantsLooks ? `=== FILE: styles.css ===\n${await readText('styles.css')}\n` : '(styles.css exists; change it only if the request is about looks)\n'}
Make the change with the smallest edits that fully solve it, keeping all other features. Return each file you changed IN FULL, using blocks like:
=== FILE: src/app.js ===
(full file content here: raw code only, no markdown fences, no <code> or <pre> tags)
Allowed files: src/app.js, index.html${wantsLooks ? ', styles.css' : ''}.`,
  );
  const files = parseFiles(reply, wantsLooks ? ['src/app.js', 'index.html', 'styles.css'] : ['src/app.js', 'index.html']);
  for (const [path, content] of Object.entries(files)) await write(path, content);
  console.log(`  changed: ${Object.keys(files).join(', ') || 'nothing'}`);
  await refineUi(provider, spec, exported, '');
  await commit(`fix: ${changeSubject(spec)}`, ['index.html', 'styles.css', 'src/app.js', 'appnar/report.json']);
}

async function changeDocs(spec) {
  const c = spec.change ?? {};
  const report = JSON.parse((await readText('appnar/report.json')) || '{}');
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `## ${date} · #${spec.revision}`,
    '',
    c.text ? `- İstek: ${c.text.replace(/\s+/g, ' ').trim()}` : null,
    c.issues?.length ? `- Otomatik kontrolün bulduğu ${c.issues.length} sorun ele alındı` : null,
    `- Kalan sorun: ${report.issues?.length ?? 0}`,
    '',
  ].filter((l) => l !== null);
  const old = await readText('CHANGELOG.md');
  const body = old.startsWith('# ') ? old.replace(/^# .*\n+/, '') : old;
  await write('CHANGELOG.md', `# Changelog\n\n${lines.join('\n')}\n${body}`);
  await commit(`docs: changelog for #${spec.revision}`, ['CHANGELOG.md']);
}

async function phaseDocs(provider, spec, env = process.env) {
  if (isChange(spec)) return changeDocs(spec);
  const plan = await loadPlan();
  const repo = env.GITHUB_REPOSITORY ?? `owner/${spec.slug}`;
  const [owner, name] = repo.split('/');
  const demo = `https://${owner}.github.io/${name}/`;
  const tr = spec.language === 'tr';

  say('think', 'writing the README introduction and feature list');
  const intro = stripFence(
    await chat(
      provider,
      rules(spec),
      `${specBlock(spec, plan)}

Write the opening of README.md in ${LANG[spec.language] ?? 'English'}: a short paragraph about the problem it solves and who it is for, then a "## ${tr ? 'Özellikler' : 'Features'}" bullet list (with one emoji per bullet). Markdown only, no title, no installation section. Under 30 lines.`,
    ),
  );

  const readme = `# ${plan.title}

[![AppNar Factory](https://github.com/${repo}/actions/workflows/appnar.yml/badge.svg)](https://github.com/${repo}/actions/workflows/appnar.yml)
[![Live demo](https://img.shields.io/badge/${tr ? 'canl%C4%B1_demo' : 'live_demo'}-online-39d353)](${demo})
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

> ${plan.tagline}

**${tr ? 'Canlı demo' : 'Live demo'}:** ${demo}

${intro.trim()}

## ${tr ? 'Nasıl çalışır' : 'How it works'}

\`\`\`mermaid
flowchart LR
  UI["index.html + styles.css"] --> APP["src/app.js<br/>${tr ? 'arayüz ve durum' : 'UI and state'}"]
  APP --> LOGIC["src/logic.js<br/>${tr ? 'saf iş kuralları' : 'pure business rules'}"]
  APP --> LS[("localStorage")]
  TESTS["tests/logic.test.js"] --> LOGIC
\`\`\`

## ${tr ? 'Yerelde çalıştır' : 'Run locally'}

\`\`\`bash
git clone https://github.com/${repo}.git
cd ${name}
npx serve .        # ${tr ? 'veya herhangi bir statik sunucu' : 'or any static server'}
npm test
\`\`\`

${tr ? 'Bağımlılık yok: düz HTML, CSS ve JavaScript modülleri.' : 'No dependencies: plain HTML, CSS and JavaScript modules.'}

## ${tr ? 'Proje yapısı' : 'Project structure'}

\`\`\`
index.html          ${tr ? 'sayfa iskeleti' : 'page markup'}
styles.css          ${tr ? 'tasarım, açık/koyu tema' : 'design system, light/dark'}
src/app.js          ${tr ? 'arayüz ve kalıcı durum' : 'UI wiring and persistence'}
src/logic.js        ${tr ? 'saf fonksiyonlar (test edilir)' : 'pure functions (unit tested)'}
tests/              ${tr ? 'node:test birim testleri' : 'node:test unit tests'}
docs/PLAN.md        ${tr ? 'ürün planı' : 'product plan'}
\`\`\`

## ${tr ? 'Lisans' : 'License'}

MIT © ${new Date().getFullYear()} ${owner}

---
<sub>${tr ? 'Bu repo' : 'This repository was generated with'} [AppNar](https://github.com/topics/appnar)${tr ? ' ile üretildi.' : '.'}</sub>
`;
  await write('README.md', readme);
  await write(
    'LICENSE',
    `MIT License

Copyright (c) ${new Date().getFullYear()} ${owner}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  );
  await commit('docs: readme and license', ['README.md', 'LICENSE']);
}

/** Final gate: tests green, files present; copies the site into dist/ for Pages. */
async function phaseVerify() {
  for (const f of ['index.html', 'styles.css', 'src/app.js', 'src/logic.js', 'tests/logic.test.js', 'README.md']) {
    if (!(await readText(f)).trim()) throw new Error(`${f} is missing`);
  }
  const result = runTests();
  if (!result.ok) {
    console.error(tail(result.output, 4000));
    throw new Error('unit tests fail');
  }
  await rm('dist', { recursive: true, force: true });
  await mkdir('dist', { recursive: true });
  for (const f of ['index.html', 'styles.css', 'src']) await cp(f, `dist/${f}`, { recursive: true });
  await writeFile('dist/.nojekyll', '');
  console.log('  site ready in dist/');
}

// ───────────────────────────── entry ─────────────────────────────

export async function main(phase) {
  const spec = await loadSpec();
  const provider = phase === 'verify' ? null : await resolveProvider(spec);
  if (provider) {
    for (const p of [provider, ...(provider.fallbacks ?? [])]) await discoverModels(p);
    const chain = [provider, ...(provider.fallbacks ?? [])].map((p) => `${p.name} (${p.models.join(', ')})`).join(' → ');
    console.log(`AppNar · ${phase} · ${chain}`);
  }
  const phases = {
    plan: () => phasePlan(provider, spec),
    logic: () => phaseLogic(provider, spec),
    ui: () => phaseUi(provider, spec),
    docs: () => phaseDocs(provider, spec),
    verify: () => phaseVerify(),
  };
  if (!phases[phase]) throw new Error(`unknown phase "${phase}"`);
  try {
    return await phases[phase]();
  } finally {
    // Failed phases used quota too; report either way.
    await reportUsage(spec);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((e) => {
    // Multi-line annotation (GitHub workflow-command escaping) so the whole reason
    // reaches the run summary and AppNar, not just the first line.
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 3000);
    console.error(`::error title=AppNar ${process.argv[2] ?? ''}::${msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    process.exit(1);
  });
}
