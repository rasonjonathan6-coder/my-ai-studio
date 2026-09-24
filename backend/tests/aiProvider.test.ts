import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { config } from '../src/config/index.ts';
import { AiProviderRouter } from '../src/services/aiProvider.ts';

/**
 * Router tests run against three real local HTTP servers, one per provider, so
 * ordering, failover and cooldown are verified against actual socket traffic.
 * `config` is captured once at import, hence the in-place mutation.
 */
type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface FakeProvider {
  server: http.Server;
  set: (r: Responder) => void;
  count: () => number;
  resetCount: () => void;
}

function makeProvider(): Promise<FakeProvider> {
  let respond: Responder = (_req, res) => { res.writeHead(200); res.end('{}'); };
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    respond(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        set: (r) => { respond = r; },
        count: () => requests,
        resetCount: () => { requests = 0; },
      });
    });
  });
}

function portOf(p: FakeProvider): string {
  const addr = p.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

function ok(message = 'ok'): Responder {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'test-model',
      choices: [{ message: { role: 'assistant', content: message } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  };
}

function failure(status: number, body: string, headers: Record<string, string> = {}): Responder {
  return (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  };
}

let orP: FakeProvider;
let gemP: FakeProvider;
let groqP: FakeProvider;
let router: AiProviderRouter;

before(async () => {
  [orP, gemP, groqP] = await Promise.all([makeProvider(), makeProvider(), makeProvider()]);
  config.openRouterBaseUrl = portOf(orP);
  config.geminiBaseUrl = portOf(gemP);
  config.groqBaseUrl = portOf(groqP);
  config.openRouterApiKey = 'test-key-openrouter';
  config.geminiApiKey = 'test-key-gemini';
  config.groqApiKey = 'test-key-groq';
  config.openRouterMaxRetries = 0;
  config.aiProviderPriority = ['openrouter', 'gemini', 'groq'];
  config.aiProviderCooldownMs = 60_000;
});

after(async () => {
  await Promise.all([orP, gemP, groqP].map((p) => new Promise<void>((r) => p.server.close(() => r()))));
});

beforeEach(() => {
  router = new AiProviderRouter();
  orP.set(ok());
  gemP.set(ok());
  groqP.set(ok());
  orP.resetCount();
  gemP.resetCount();
  groqP.resetCount();
});

const call = { messages: [{ role: 'user' as const, content: 'hi' }] };

test('AUTO uses the first provider in the configured order when it is healthy', async () => {
  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'openrouter');
  assert.equal(out.failoverFrom, null);
  assert.equal(gemP.count(), 0, 'no request should reach the second provider');
});

test('AUTO fails over to the next provider when the first returns a daily quota', async () => {
  orP.set(failure(429, JSON.stringify({
    error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 },
  }), { 'x-ratelimit-reset': String(Date.now() + 3_600_000) }));

  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'gemini');
  assert.equal(out.failoverFrom, 'openrouter');
  assert.equal(orP.count(), 1);
  assert.equal(gemP.count(), 1);
});

test('AUTO skips a provider that is in cooldown after a quota', async () => {
  orP.set(failure(429, JSON.stringify({ error: { message: 'quota exceeded' } })));
  await router.chat('auto', call);
  const firstCount = orP.count();

  // Second call within the cooldown window must not touch OpenRouter again.
  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'gemini');
  assert.equal(orP.count(), firstCount, 'the cooling provider must be skipped');
});

test('AUTO does not fail over on a bad credential; the real error surfaces', async () => {
  orP.set(failure(401, JSON.stringify({ error: { message: 'invalid api key' } })));

  const out = await router.chat('auto', call);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'http_error');
  assert.equal(out.provider, 'openrouter');
  assert.equal(gemP.count(), 0, 'a misconfigured provider must not be masked by failover');
});

test('AUTO reports not_configured only when no provider has a key', async () => {
  const saved = { o: config.openRouterApiKey, g: config.geminiApiKey, q: config.groqApiKey };
  config.openRouterApiKey = '';
  config.geminiApiKey = '';
  config.groqApiKey = '';
  try {
    const out = await router.chat('auto', call);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.kind, 'not_configured');
  } finally {
    config.openRouterApiKey = saved.o;
    config.geminiApiKey = saved.g;
    config.groqApiKey = saved.q;
  }
});

test('a pinned provider is used even when another would be tried first in AUTO', async () => {
  const out = await router.chat('groq', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'groq');
  assert.equal(orP.count(), 0);
  assert.equal(gemP.count(), 0);
});

test('pinned mode reports the failure instead of silently switching provider', async () => {
  groqP.set(failure(500, 'boom'));
  const out = await router.chat('groq', call);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.provider, 'groq');
  assert.equal(orP.count(), 0, 'a pinned run must never reach another provider');
});

test('cooldown can be cleared so a recovered provider is retried', async () => {
  orP.set(failure(429, JSON.stringify({ error: { message: 'quota exceeded' } })));
  await router.chat('auto', call);
  assert.equal(router.isCooling('openrouter'), true);

  router.clearCooldown('openrouter');
  assert.equal(router.isCooling('openrouter'), false);

  orP.set(ok());
  const out = await router.chat('auto', call);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.provider, 'openrouter');
});

test('no key material is ever placed in an attempt record', async () => {
  orP.set(failure(500, 'provider exploded'));
  const out = await router.chat('auto', call);
  assert.equal(out.ok, true, 'AUTO should recover on the next provider');

  const serialized = JSON.stringify(router.recentAttempts());
  for (const secret of [config.openRouterApiKey, config.geminiApiKey, config.groqApiKey]) {
    assert.equal(serialized.includes(secret), false, 'a key value must never appear in attempt metadata');
  }
});

test('request counters tally observed attempts per provider, not invented quotas', async () => {
  orP.set(failure(429, JSON.stringify({ error: { message: 'quota exceeded' } })));
  await router.chat('auto', call);

  const counters = router.requestCounters();
  // OpenRouter was attempted and refused; Gemini answered. One real request each.
  assert.equal(counters.openrouter.attempts, 1);
  assert.equal(counters.openrouter.failed, 1);
  assert.equal(counters.openrouter.ok, 0);
  assert.equal(counters.gemini.attempts, 1);
  assert.equal(counters.gemini.ok, 1);
  // Groq was never contacted, so its count stays at zero.
  assert.equal(counters.groq.attempts, 0);
  assert.equal(groqP.count(), 0);
});

test('a pinned provider still counts its own attempt', async () => {
  await router.chat('groq', call);
  const counters = router.requestCounters();
  assert.equal(counters.groq.attempts, 1);
  assert.equal(counters.openrouter.attempts, 0);
  assert.equal(counters.gemini.attempts, 0);
});
