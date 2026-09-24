import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../src/server.ts';
import { config } from '../src/config/index.ts';
import { aiRouter } from '../src/services/aiProvider.ts';
import { isReady } from '../src/routes/system.ts';

/**
 * The health endpoints are driven through the real Express app over a real
 * socket, so the assertions describe the bytes a client receives rather than a
 * hand-built object.
 */
let server: Server;
let base: string;

before(async () => {
  const app = await createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('health reports per-provider configuration and never a key', async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'my-ai-studio');

  // Every provider the router knows about must appear, so adding a provider
  // cannot leave the probe silently under-reporting.
  const expected = aiRouter.providers().map((p) => p.id).sort();
  assert.deepEqual(Object.keys(body.providers).sort(), expected);

  for (const [id, state] of Object.entries(body.providers)) {
    assert.ok(state === 'configured' || state === 'not_configured', `${id} state is a known value`);
  }

  // The legacy single field must stay consistent with the new map.
  assert.equal(body.openrouter, body.providers.openrouter);

  const serialised = JSON.stringify(body);
  assert.ok(!/sk-or-|AIza|AQ\.|gsk_/.test(serialised), 'no credential shape appears in the payload');
  assert.ok(!serialised.includes(config.openRouterApiKey || '\u0000'), 'the OpenRouter key is absent');
});

test('system info exposes the AI gateway status without any key', async () => {
  const res = await fetch(`${base}/api/system/info`);
  const body = await res.json();

  assert.equal(res.status, 200);
  const gateway = body.aiProviders;
  assert.ok(gateway, 'the AI gateway block is present');
  assert.equal(typeof gateway.defaultProvider, 'string');
  assert.deepEqual(gateway.order, aiRouter.providers().map((p) => p.id), 'the order lists every provider');

  for (const p of gateway.providers) {
    // A key existing is not a successful call, so connection must stay honest.
    assert.equal(p.connection, 'NOT_TESTED', `${p.id} is not claimed connected on configuration alone`);
    assert.equal(p.status, p.configured ? 'CONFIGURED' : 'NOT_CONFIGURED');
  }

  const serialised = JSON.stringify(body);
  assert.ok(!/sk-or-|AIza|AQ\.|gsk_/.test(serialised), 'no credential shape appears in the payload');
  assert.ok(!serialised.includes(config.openRouterApiKey || '\u0000'), 'the OpenRouter key is absent');
  assert.ok(!serialised.includes(config.geminiApiKey || '\u0000'), 'the Gemini key is absent');
  assert.ok(!serialised.includes(config.groqApiKey || '\u0000'), 'the Groq key is absent');
});

test('readiness accepts any configured provider, not just OpenRouter', async () => {
  const res = await fetch(`${base}/api/health/ready`);
  const body = await res.json();

  const anyConfigured = Object.values(body.checks.providers).some((s) => s === 'configured');
  const dbUp = body.checks.database === 'UP';

  // The decision rule under test: database up AND at least one provider.
  assert.equal(body.ok, isReady(dbUp, body.checks.providers));
  assert.equal(res.status, body.ok ? 200 : 503);
});

test('readiness rule does not hinge on OpenRouter alone', () => {
  const geminiOnly = { openrouter: 'not_configured' as const, gemini: 'configured' as const, groq: 'not_configured' as const };
  assert.equal(isReady(true, geminiOnly), true, 'a Gemini-only deployment is ready');

  const noneConfigured = { openrouter: 'not_configured' as const, gemini: 'not_configured' as const, groq: 'not_configured' as const };
  assert.equal(isReady(true, noneConfigured), false, 'no provider means no run can be served');

  assert.equal(isReady(false, geminiOnly), false, 'a database outage is not ready regardless of providers');
});
