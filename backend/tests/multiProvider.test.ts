import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config/index.ts';
import {
  AiProviderRouter, PROVIDER_IDS, isProviderId, makeAdapter,
  type ProviderAdapter, type ProviderId,
} from '../src/services/aiProvider.ts';
import { MockProvider, mock401, mock429, mock500, mockSuccess, mockTimeout } from './mockProviders.ts';

/**
 * These tests drive the real routing, classification and cooldown code through
 * mock services, so the whole failover chain is verified without spending a
 * single request against a real provider quota.
 */
const PRIORITY: ProviderId[] = ['openrouter', 'gemini', 'groq'];

const saved = {
  priority: config.aiProviderPriority,
  cooldown: config.aiProviderCooldownMs,
  maxCooldown: config.aiProviderCooldownMaxMs,
};

function build(mocks: Partial<Record<ProviderId, MockProvider>>): AiProviderRouter {
  const overrides: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const [id, svc] of Object.entries(mocks)) {
    if (svc && isProviderId(id)) overrides[id] = makeAdapter(id, svc);
  }
  return new AiProviderRouter(overrides);
}

const call = { messages: [{ role: 'user' as const, content: 'hi' }] };

beforeEach(() => {
  config.aiProviderPriority = [...PRIORITY];
  config.aiProviderCooldownMs = 30_000;
  config.aiProviderCooldownMaxMs = 900_000;
});

after(() => {
  config.aiProviderPriority = saved.priority;
  config.aiProviderCooldownMs = saved.cooldown;
  config.aiProviderCooldownMaxMs = saved.maxCooldown;
});

test('the registry exposes every documented provider id', () => {
  const expected = [
    'openrouter', 'gemini', 'groq', 'cerebras', 'mistral', 'cloudflare',
    'nvidia', 'huggingface', 'chutes', 'sambanova', 'ollama', 'vllm',
  ];
  assert.deepEqual([...PROVIDER_IDS], expected);
});

test('AUTO walks a multi-provider failover chain and reports every attempt', async () => {
  const or = mock429('openrouter', { body: 'quota exceeded' });
  const gem = mock500('gemini');
  const groq = mockSuccess('groq');
  const router = build({ openrouter: or, gemini: gem, groq });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'groq');
  assert.equal(out.failoverFrom, 'openrouter', 'failover started at the first provider');
  assert.deepEqual(out.attempts.map((a) => a.provider), ['openrouter', 'gemini', 'groq']);
  assert.deepEqual(out.attempts.map((a) => a.outcome), ['fallback', 'fallback', 'ok']);
  // Every mock was contacted exactly once: no provider is retried in one pass.
  assert.equal(or.calls, 1);
  assert.equal(gem.calls, 1);
  assert.equal(groq.calls, 1);
});

test('a hard quota puts a provider in cooldown and AUTO skips it next time', async () => {
  const or = mock429('openrouter', { body: 'free-models-per-day' });
  const gem = mockSuccess('gemini');
  const router = build({ openrouter: or, gemini: gem });

  await router.chat('auto', call);
  assert.equal(router.isCooling('openrouter'), true);

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'gemini');
  assert.equal(or.calls, 1, 'a cooling provider must not be contacted again');
});

test('a bad credential is classified AUTHENTICATION and never masked by failover', async () => {
  const or = mock401('openrouter');
  const gem = mockSuccess('gemini');
  const router = build({ openrouter: or, gemini: gem });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'http_error');
  assert.equal(out.attempts[0].classification, 'AUTHENTICATION');
  assert.equal(gem.calls, 0, 'a misconfigured provider must surface, not fail over');
  assert.equal(router.isCooling('openrouter'), false, 'a bad key is not a load problem');
});

test('a timeout fails over to the next provider', async () => {
  const or = mockTimeout('openrouter');
  const gem = mockSuccess('gemini');
  const router = build({ openrouter: or, gemini: gem });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'gemini');
  assert.equal(or.calls, 1);
  assert.equal(gem.calls, 1);
});

test('a JSON body mentioning quota still classifies as a hard limit', async () => {
  const or = mock429('openrouter', { body: JSON.stringify({ error: { message: 'Resource exhausted: quota' } }) });
  const router = build({ openrouter: or, gemini: mockSuccess('gemini') });
  const out = await router.chat('auto', call);
  assert.equal(out.attempts[0].classification, 'QUOTA_RATE_LIMIT');
  assert.equal(router.isCooling('openrouter'), true);
});

test('repeated limits escalate the cooldown, and success resets it', async () => {
  const or = mock429('openrouter', { body: 'rate limit' });
  const router = build({ openrouter: or, gemini: mockSuccess('gemini') });

  // A pinned call bypasses the cooldown check, so it is the way to observe what
  // a second consecutive limit does to the ladder.
  await router.chat('openrouter', call);
  const first = router.providerStates().find((s) => s.id === 'openrouter');
  assert.equal(first?.cooldownStrike, 1);
  assert.equal(first?.cooldownReason?.startsWith('QUOTA_RATE_LIMIT'), true);

  await router.chat('openrouter', call);
  const second = router.providerStates().find((s) => s.id === 'openrouter');
  assert.equal(second?.cooldownStrike, 2, 'the backoff ladder advances on a repeat limit');

  // A success must clear the ladder so a recovered provider is trusted again.
  or.script = { status: 200 };
  await router.chat('openrouter', call);
  const third = router.providerStates().find((s) => s.id === 'openrouter');
  assert.equal(third?.cooldownStrike, 0);
  assert.equal(third?.available, true);
  assert.equal(router.isCooling('openrouter'), false);
});

test('provider state reports observed facts and leaves unknowns null', async () => {
  const or = mockSuccess('openrouter');
  const gem = mock401('gemini');
  const router = build({ openrouter: or, gemini: gem });

  await router.chat('openrouter', call);
  await router.chat('gemini', call);

  const states = router.providerStates();
  const orState = states.find((s) => s.id === 'openrouter');
  const gemState = states.find((s) => s.id === 'gemini');
  const untouched = states.find((s) => s.id === 'vllm');

  assert.equal(orState?.available, true, 'a real success proves availability');
  assert.equal(orState?.lastStatusCode, 200);
  assert.equal(orState?.successCount, 1);
  assert.equal(gemState?.available, false);
  assert.equal(gemState?.lastStatusCode, 401);
  assert.equal(gemState?.failureCount, 1);
  // A provider that was never contacted reports null, not a plausible default.
  assert.equal(untouched?.lastStatusCode, null);
  assert.equal(untouched?.rateLimitRemainingRequests, null);
  assert.equal(untouched?.requestCount, 0);
});

test('no provider state entry ever carries a key value', async () => {
  config.openRouterApiKey = 'sk-or-secret-must-not-appear';
  const router = build({ openrouter: mock500('openrouter'), gemini: mockSuccess('gemini') });
  await router.chat('auto', call);

  const serialized = JSON.stringify({ states: router.providerStates(), attempts: router.recentAttempts() });
  assert.equal(serialized.includes('sk-or-secret-must-not-appear'), false);
  config.openRouterApiKey = '';
});

test('an externally observed success makes the provider available and counted', async () => {
  const router = build({ openrouter: mockSuccess('openrouter') });
  const before = router.providerStates().find((s) => s.id === 'openrouter');
  assert.equal(before?.available, false, 'nothing has proven it yet');
  assert.equal(before?.requestCount, 0);

  router.noteTest('openrouter', {
    ok: true, model: 'm', content: 'OK', usage: null,
    rateLimit: {
      limitRequests: 1000, remainingRequests: 997, limitTokens: null,
      remainingTokens: null, resetRequestsAt: null, resetTokensAt: null, retryAfterAt: null,
    },
  });

  const after = router.providerStates().find((s) => s.id === 'openrouter');
  assert.equal(after?.available, true, 'a real round trip is the only proof of availability');
  assert.equal(after?.lastStatusCode, 200);
  assert.equal(after?.requestCount, 1, 'an externally observed request is still a real request');
  assert.equal(after?.successCount, 1);
  assert.equal(after?.rateLimitRemainingRequests, 997, 'observed headers are surfaced verbatim');
});

test('an unconfigured provider is never counted by an external observation', () => {
  const router = build({ groq: new MockProvider('groq', { status: 200 }, false) });
  router.noteFailure('groq', { ok: false, kind: 'not_configured', message: 'no key', retryable: false, status: null });
  const state = router.providerStates().find((s) => s.id === 'groq');
  assert.equal(state?.requestCount, 0, 'no request was made, so none is counted');
  assert.equal(router.isCooling('groq'), false);
});

test('an unconfigured local provider is skipped without being counted', async () => {
  const ollamaMock = new MockProvider('ollama', { status: 200 }, false);
  const gem = mockSuccess('gemini');
  const router = build({ ollama: ollamaMock, gemini: gem });

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(ollamaMock.calls, 0, 'an unconfigured provider must never be contacted');
  assert.equal(out.attempts.some((a) => a.provider === 'ollama'), false);
});
