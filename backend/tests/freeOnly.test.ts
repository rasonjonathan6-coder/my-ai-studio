/**
 * FREE_ONLY routing tests.
 *
 * The point of these cases is the money: FREE_ONLY must never reach a paid
 * provider or a paid model, and when the free pool is empty it must say so
 * rather than fall through to something that costs. The mocks let that be
 * checked by counting requests: a paid provider that was contacted would show
 * up as a call, so "not contacted" is proved, not asserted from a message.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.ts';
import { AiProviderRouter, makeAdapter, type ProviderAdapter, type ProviderId } from '../src/services/aiProvider.ts';
import { observeModel, freeEligibleModels, resetRegistry } from '../src/services/modelRegistry.ts';
import { MOCK_CAPABILITIES } from './mockProviders.ts';
import type { ChatOptions, ChatOutcome } from '../src/services/providerClient.ts';
import type { ProviderService } from '../src/services/providers.ts';

/**
 * A provider that answers per model id, so a case can make one free model fail
 * while its sibling succeeds. Calls are recorded with the model, which is what
 * lets a test prove *which* model was reached.
 */
class ModelProvider implements ProviderService {
  public calls: Array<string> = [];
  /** Timeout the router asked for on each attempt, in call order. */
  public timeouts: Array<number | undefined> = [];
  private readonly name: string;
  private readonly configured: boolean;
  private readonly script: Record<string, { status: number; body?: string; retryAfter?: number }>;
  private readonly fallback: { status: number; body?: string; retryAfter?: number };

  public constructor(
    name: string,
    script: Record<string, { status: number; body?: string; retryAfter?: number }>,
    fallback: { status: number; body?: string; retryAfter?: number } = { status: 200 },
    configured = true,
  ) {
    this.name = name;
    this.script = script;
    this.fallback = fallback;
    this.configured = configured;
  }

  public isConfigured(): boolean { return this.configured; }
  public status(): { configured: boolean; model: string; baseUrl: string } {
    return { configured: this.configured, model: `default-${this.name}`, baseUrl: `http://mock.invalid/${this.name}` };
  }
  public capabilities(): typeof MOCK_CAPABILITIES { return MOCK_CAPABILITIES; }
  public async listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    return { ok: true, models: Object.keys(this.script) };
  }
  public async chat(options: ChatOptions): Promise<ChatOutcome> {
    const model = options.model ?? `default-${this.name}`;
    this.calls.push(model);
    this.timeouts.push(options.timeoutMs);
    const s = this.script[model] ?? this.fallback;
    if (s.status === 200) {
      return {
        ok: true, content: `reply from ${model}`, model,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, rateLimit: null, raw: {},
      };
    }
    const quotaExhausted = /quota|exhausted/i.test(s.body ?? '');
    return {
      ok: false, kind: s.status === 429 ? 'rate_limited' : 'http_error',
      message: s.body ?? `HTTP ${s.status}`, status: s.status,
      retryable: s.status >= 500 || (s.status === 429 && !quotaExhausted),
      quotaExhausted,
      classification: s.status === 429 ? 'QUOTA_RATE_LIMIT' : s.status === 402 ? 'QUOTA_RATE_LIMIT' : 'BAD_REQUEST',
      retryAfterMs: s.retryAfter,
    };
  }
}

function build(overrides: Partial<Record<ProviderId, ProviderService>>): AiProviderRouter {
  const table: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const [id, svc] of Object.entries(overrides)) {
    if (svc) table[id as ProviderId] = makeAdapter(id as ProviderId, svc);
  }
  return new AiProviderRouter(table);
}

const call = { messages: [{ role: 'user' as const, content: 'hi' }] };

/** Real provider keys, saved so the whole file can run with none configured. */
const savedKeys = {
  openrouter: config.openRouterApiKey, gemini: config.geminiApiKey, groq: config.groqApiKey,
  cerebras: config.cerebrasApiKey, mistral: config.mistralApiKey, cloudflare: config.cloudflareApiToken,
  nvidia: config.nvidiaApiKey, hf: config.hfToken, chutes: config.chutesApiKey,
  sambanova: config.sambanovaApiKey, ollama: config.ollamaBaseUrl, vllm: config.vllmBaseUrl,
};

beforeEach(() => {
  // groq is free-tier, cerebras and mistral are paid: the mix a FREE_ONLY case
  // needs to prove the paid ones stay untouched.
  config.aiProviderPriority = ['openrouter', 'groq', 'cerebras', 'mistral'];
  config.aiProviderCooldownMs = 60_000;
  config.aiMaxFreeModelAttempts = 3;
  config.aiFreeModelTimeoutMs = 45_000;
  config.freeOnly = true;
  // Observations from one case must not decide another's eligible set.
  resetRegistry();
  // Every real provider is unconfigured here, so only the mocks a case installs
  // can serve a request. Without this a key from the developer's .env would let
  // a case reach a real API and spend real quota.
  config.openRouterApiKey = '';
  config.geminiApiKey = '';
  config.groqApiKey = '';
  config.cerebrasApiKey = '';
  config.mistralApiKey = '';
  config.cloudflareApiToken = '';
  config.cloudflareAccountId = '';
  config.nvidiaApiKey = '';
  config.hfToken = '';
  config.chutesApiKey = '';
  config.sambanovaApiKey = '';
  config.ollamaBaseUrl = '';
  config.vllmBaseUrl = '';
});

after(() => {
  config.openRouterApiKey = savedKeys.openrouter;
  config.geminiApiKey = savedKeys.gemini;
  config.groqApiKey = savedKeys.groq;
  config.cerebrasApiKey = savedKeys.cerebras;
  config.mistralApiKey = savedKeys.mistral;
  config.cloudflareApiToken = savedKeys.cloudflare;
  config.nvidiaApiKey = savedKeys.nvidia;
  config.hfToken = savedKeys.hf;
  config.chutesApiKey = savedKeys.chutes;
  config.sambanovaApiKey = savedKeys.sambanova;
  config.ollamaBaseUrl = savedKeys.ollama;
  config.vllmBaseUrl = savedKeys.vllm;
  config.freeOnly = false;
});

test('FREE_ONLY picks a free OpenRouter model and never touches a paid provider', async () => {
  const or = new ModelProvider('openrouter', {}, { status: 200 });
  const groq = new ModelProvider('groq', {}, { status: 200 });
  const cerebras = new ModelProvider('cerebras', {}, { status: 200 });
  const mistral = new ModelProvider('mistral', {}, { status: 200 });
  const router = build({ openrouter: or, groq, cerebras, mistral });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'openrouter');
  // The model chosen must be one of OpenRouter's registered free models.
  assert.ok(out.model.includes(':free'), `expected a :free model, got ${out.model}`);
  assert.equal(cerebras.calls.length, 0, 'the paid Cerebras provider must not be contacted');
  assert.equal(mistral.calls.length, 0, 'the paid Mistral provider must not be contacted');
});

test('FREE_ONLY pins to a paid provider and refuses without contacting it', async () => {
  const cerebras = new ModelProvider('cerebras', {}, { status: 200 });
  const router = build({ openrouter: new ModelProvider('openrouter', {}, { status: 200 }), cerebras });

  const out = await router.chat('cerebras', call);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.message, /FREE_ONLY/);
  assert.match(out.message, /paid provider/i);
  assert.equal(cerebras.calls.length, 0, 'a refused paid provider must receive no request');
});

test('FREE_ONLY tries the next free model when the first is rate limited', async () => {
  // Every free model of OpenRouter is throttled; Groq then answers. The trail
  // must show per-model attempts, not a single provider-level attempt.
  const misses = Object.fromEntries(
    ['nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere/north-mini-code:free', 'nvidia/nemotron-3-super-120b-a12b:free']
      .map((m) => [m, { status: 429, body: 'temporarily rate-limited upstream' }]),
  );
  const or = new ModelProvider('openrouter', misses, { status: 429, body: 'temporarily rate-limited upstream' });
  const groq = new ModelProvider('groq', {}, { status: 200 });
  const router = build({ openrouter: or, groq });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'groq', 'failover must leave the throttled provider');
  assert.equal(out.failoverFrom, 'openrouter');
  // At most aiMaxFreeModelAttempts OpenRouter models were tried before moving on.
  assert.ok(or.calls.length >= 1 && or.calls.length <= config.aiMaxFreeModelAttempts,
    `expected 1..${config.aiMaxFreeModelAttempts} OpenRouter attempts, got ${or.calls.length}`);
  // The attempt trail names each model, which is what makes the failover auditable.
  const orAttempts = out.attempts.filter((a) => a.provider === 'openrouter');
  assert.equal(orAttempts.length, or.calls.length);
  assert.ok(orAttempts.every((a) => a.model.includes(':free')));
});

test('FREE_ONLY reports NO_FREE_PROVIDER_AVAILABLE when only paid providers are usable', async () => {
  const cerebras = new ModelProvider('cerebras', {}, { status: 200 });
  const mistral = new ModelProvider('mistral', {}, { status: 200 });
  const router = build({ cerebras, mistral });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, 'NO_FREE_PROVIDER_AVAILABLE');
  assert.match(out.message, /NO_FREE_PROVIDER_AVAILABLE/);
  assert.equal(cerebras.calls.length, 0);
  assert.equal(mistral.calls.length, 0);
});

test('FREE_ONLY never falls back to a free provider\'s default model when it has no free model registered', async () => {
  // Ollama is a free-tier provider with no registered model ids. FREE_ONLY must
  // refuse rather than quietly send the request to the provider's default model,
  // which is the paid-model-of-a-free-provider failure mode.
  const ollama = new ModelProvider('ollama', { 'qwen2.5-coder:7b': { status: 200 } }, { status: 200 });
  const router = build({ ollama });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, 'NO_FREE_PROVIDER_AVAILABLE');
  assert.equal(ollama.calls.length, 0, 'no request may be sent when no free model is registered');
});

test('FREE_ONLY excludes a free model known to require payment', async () => {
  const router = build({ openrouter: new ModelProvider('openrouter', {}, { status: 200 }) });
  // Mark one registered free model as payment-blocked by observing a real 402.
  assert.ok(observeModel('openrouter', 'cohere/north-mini-code:free', 402, 'completion', 'insufficient credits'));
  assert.ok(!freeEligibleModels('openrouter').includes('cohere/north-mini-code:free'),
    'a model that answered 402 must leave the eligible set');
  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (out.ok) assert.notEqual(out.model, 'cohere/north-mini-code:free');
});

test('FREE_ONLY bounds each free model attempt so one stall cannot consume the run', async () => {
  const or = new ModelProvider('openrouter', {}, { status: 200 });
  const router = build({ openrouter: or });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  assert.ok(or.timeouts.length > 0);
  // Every attempt carries the configured ceiling, which is what keeps a stalled
  // free model from eating the agent's whole time budget.
  assert.ok(or.timeouts.every((t) => t === config.aiFreeModelTimeoutMs),
    `expected ${config.aiFreeModelTimeoutMs}ms per attempt, got ${or.timeouts.join(',')}`);
});

test('per-model cooldown silences a throttled model but not its siblings', async () => {
  // The first candidate answers 429 and the rest answer 200.
  const free = freeEligibleModels('openrouter');
  assert.ok(free.length >= 2, 'the registry must expose at least two free OpenRouter models');
  const script: Record<string, { status: number; body?: string }> = { [free[0]]: { status: 429, body: 'temporarily rate-limited upstream' } };
  const or = new ModelProvider('openrouter', script, { status: 200 });
  const router = build({ openrouter: or });

  const first = await router.chat('auto', call);
  assert.equal(first.ok, true);
  assert.ok(router.isModelCooling('openrouter', free[0]), 'the throttled model must be cooling');
  assert.ok(!router.isModelCooling('openrouter', free[1]), 'a sibling model must stay usable');

  const callsBefore = or.calls.length;
  assert.ok(callsBefore > 0);
  or.calls = [];
  const second = await router.chat('auto', call);
  assert.equal(second.ok, true);
  assert.ok(!or.calls.includes(free[0]), 'the cooling model must not be retried');
});
