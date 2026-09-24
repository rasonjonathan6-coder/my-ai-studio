/**
 * AI provider endpoints.
 *
 * `/api/ai/providers` reports configuration and cooldown state. The
 * `/api/ai/providers/:id/test` endpoints perform a real completion request
 * against the provider's own API and report the observed HTTP status - a
 * provider is never labelled "connected" without an actual round trip.
 */
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config/index.ts';
import { asyncHandler, validate } from '../middleware/validate.ts';
import { requireAuth } from '../middleware/auth.ts';
import { aiRouter, PROVIDER_IDS, isProviderId, type ProviderAdapter, type ProviderId } from '../services/aiProvider.ts';
import { logger, redact } from '../lib/logger.ts';

const router = Router();

function providerSummary(): Array<{
  id: ProviderId;
  label: string;
  local: boolean;
  configured: boolean;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  connection: 'NOT_TESTED';
  model: string | null;
  endpoint: string;
  cooling: boolean;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  capabilities: ReturnType<ProviderAdapter['capabilities']>;
}> {
  const cooldowns = aiRouter.cooldownState();
  return aiRouter.providers().map((p) => {
    const s = p.status();
    const c = cooldowns[p.id];
    return {
      id: p.id,
      label: p.label,
      local: p.local,
      configured: s.configured,
      status: s.configured ? 'CONFIGURED' as const : 'NOT_CONFIGURED' as const,
      // Connection is only proven by a real request through the test endpoint.
      connection: 'NOT_TESTED' as const,
      model: s.model || null,
      endpoint: s.baseUrl,
      cooling: c.cooling,
      cooldownUntil: c.until,
      cooldownReason: c.reason,
      capabilities: p.capabilities(),
    };
  });
}

/**
 * The single provider a request would use right now, with the reason. Derived
 * from the router's real order and cooldown state, never from a guess.
 */
function currentProvider(): {
  provider: ProviderId | null;
  label: string | null;
  model: string | null;
  reason: string;
} {
  const auto = aiRouter.autoOrder();
  const first = auto.ready[0];
  if (first) {
    const s = aiRouter.adapter(first).status();
    return {
      provider: first,
      label: aiRouter.adapter(first).label,
      model: s.model || null,
      reason: 'Primary provider: first configured provider in priority order that is not cooling',
    };
  }
  if (auto.cooling.length > 0) {
    return {
      provider: null,
      label: null,
      model: null,
      reason: 'All configured providers are cooling down after a limit response',
    };
  }
  return {
    provider: null,
    label: null,
    model: null,
    reason: auto.unconfigured.length === PROVIDER_IDS.length
      ? 'No provider is configured on the server'
      : 'No configured provider is available',
  };
}

/** Order in which AUTO would try providers, before cooldown filtering. */
function priorityOrder(): ProviderId[] {
  const seen = new Set<ProviderId>();
  const order: ProviderId[] = [];
  for (const raw of config.aiProviderPriority) {
    if (isProviderId(raw) && !seen.has(raw)) {
      seen.add(raw);
      order.push(raw);
    }
  }
  for (const id of PROVIDER_IDS) if (!seen.has(id)) order.push(id);
  return order;
}

/** Shared by /api/ai/providers and /api/system/info. */
export function aiProviderStatus(): {
  defaultProvider: string;
  order: string[];
  priority: string[];
  cooldownMs: number;
  providers: ReturnType<typeof providerSummary>;
  providerStates: ReturnType<typeof aiRouter.providerStates>;
  current: ReturnType<typeof currentProvider>;
  auto: ReturnType<typeof aiRouter.autoOrder>;
  recentAttempts: ReturnType<typeof aiRouter.recentAttempts>;
  requestCounters: ReturnType<typeof aiRouter.requestCounters>;
  quotaRemaining: 'unknown';
} {
  // The auto view is also used to drive the frontend selector, so paths are
  // reported per provider and no request is made here.
  const auto = aiRouter.autoOrder();
  return {
    defaultProvider: config.aiDefaultProvider,
    order: auto.ready.concat(auto.cooling, auto.unconfigured),
    priority: priorityOrder(),
    cooldownMs: config.aiProviderCooldownMs,
    providers: providerSummary(),
    providerStates: aiRouter.providerStates(),
    current: currentProvider(),
    auto,
    recentAttempts: aiRouter.recentAttempts(),
    // Observed request counts only; no provider API exposes a remaining quota,
    // so that figure is reported as unknown instead of being invented.
    requestCounters: aiRouter.requestCounters(),
    quotaRemaining: 'unknown',
  };
}

router.get('/providers', requireAuth, asyncHandler(async (_req, res) => {
  res.json(aiProviderStatus());
}));

const testSchema = z.object({
  /** Optional model override; validated against a safe pattern below. */
  model: z.string().min(1).max(200).optional(),
});

/** Model ids contain letters, digits and the punctuation providers actually use. */
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/**
 * Checks a provider is reachable and its credentials are accepted without
 * spending any completion quota: it asks for the model list, which is a
 * read-only call billed as zero tokens. A provider can be CONFIGURED and still
 * fail this, which is exactly the distinction the UI needs to show.
 */
router.post('/providers/:id/probe', requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isProviderId(id)) {
    res.status(400).json({ error: 'unknown provider', allowed: PROVIDER_IDS });
    return;
  }
  const adapter = aiRouter.adapter(id);
  const status = adapter.status();
  if (!status.configured) {
    res.json({
      provider: id,
      label: adapter.label,
      result: 'NOT_CONFIGURED',
      endpoint: status.baseUrl,
      quotaCost: 'none',
      message: `${adapter.label} is not configured on the server.`,
    });
    return;
  }

  const started = Date.now();
  const outcome = await adapter.listModels();
  const durationMs = Date.now() - started;
  logger.info('ai provider probe', { provider: id, ok: outcome.ok, durationMs, models: outcome.models.length });

  res.json({
    provider: id,
    label: adapter.label,
    result: outcome.ok ? 'REACHABLE' : 'FAIL',
    endpoint: status.baseUrl,
    // The list-models call consumes no completion tokens, unlike /test.
    quotaCost: 'none',
    models: outcome.models.slice(0, 50),
    modelCount: outcome.models.length,
    durationMs,
    message: outcome.ok ? null : redact(outcome.error ?? 'probe failed').slice(0, 300),
  });
}));

router.post('/providers/:id/test', requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isProviderId(id)) {
    res.status(400).json({ error: 'unknown provider', allowed: PROVIDER_IDS });
    return;
  }
  const body = validate(testSchema, req.body ?? {});
  if (body.model && !MODEL_PATTERN.test(body.model)) {
    res.status(400).json({ error: 'invalid model id' });
    return;
  }

  const adapter = aiRouter.adapter(id);
  const status = adapter.status();
  if (!status.configured) {
    res.status(200).json({
      provider: id,
      label: adapter.label,
      result: 'NOT_CONFIGURED',
      model: status.model,
      endpoint: status.baseUrl,
      message: `${adapter.label} API key is not configured on the server.`,
    });
    return;
  }

  const started = Date.now();
  const outcome = await adapter.chat({
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    model: body.model,
    maxTokens: 256,
    timeoutMs: 30_000,
  });
  const durationMs = Date.now() - started;

  if (outcome.ok) {
    // A real success is a fact about the provider, so it becomes available in
    // the shared state. Otherwise the UI would show PASS while /api/ai/providers
    // still reported the provider as never exercised.
    aiRouter.noteTest(id, outcome);
    logger.info('ai provider test', { provider: id, http: 200, durationMs, model: outcome.model });
    res.json({
      provider: id,
      label: adapter.label,
      result: 'PASS',
      model: outcome.model,
      endpoint: status.baseUrl,
      http: 200,
      durationMs,
      // A completion test spends real quota; saying so lets the UI warn first.
      quotaCost: 'one completion',
      usage: outcome.usage,
      rateLimit: outcome.rateLimit,
      reply: outcome.content.slice(0, 200),
    });
    return;
  }

  logger.warn('ai provider test failed', { provider: id, kind: outcome.kind, status: outcome.status, durationMs });
  // A hard quota observed here is a fact about the provider, so record it in
  // the shared router state: AUTO must not keep sending runs at a provider that
  // this very check just proved to be exhausted.
  if (outcome.kind === 'rate_limited') aiRouter.noteFailure(id, outcome);
  res.json({
    provider: id,
    label: adapter.label,
    result: 'FAIL',
    model: status.model,
    endpoint: status.baseUrl,
    http: outcome.status ?? null,
    kind: outcome.kind,
    classification: outcome.classification ?? null,
    quotaExhausted: outcome.quotaExhausted === true,
    durationMs,
    message: redact(outcome.message).slice(0, 500),
  });
}));

/** Clears a provider cooldown so an operator can retry it immediately. */
router.post('/providers/:id/reset', requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isProviderId(id)) {
    res.status(400).json({ error: 'unknown provider', allowed: PROVIDER_IDS });
    return;
  }
  aiRouter.clearCooldown(id);
  res.json({ provider: id, cooldownCleared: true });
}));

/**
 * Sends one real request through the AUTO path and reports which provider
 * answered. Used to prove failover without exposing any key.
 */
router.post('/providers/:id/auto-probe', requireAuth, asyncHandler(async (_req, res) => {
  const outcome = await aiRouter.chat('auto', {
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    maxTokens: 256,
    timeoutMs: 30_000,
  });
  res.json({
    ok: outcome.ok,
    answeredBy: outcome.ok ? outcome.provider : null,
    failoverFrom: outcome.ok ? outcome.failoverFrom : null,
    // The full trail is returned so the failover chain is visible, not implied.
    attempts: outcome.attempts,
    quotaCost: 'one completion per attempted provider',
    message: outcome.ok ? null : redact(outcome.message).slice(0, 500),
  });
}));

export default router;
