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
import {
  listModels, registrySummary, syncOpenRouterCatalogue, observeModel, classifyHttp,
  PROVIDER_TIERS, freeEligibleModels,
} from '../services/modelRegistry.ts';
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
  /** Whether this provider can be used without billing, and why. */
  tier: 'free' | 'paid';
  tierReason: string;
  /** Free models eligible under FREE_ONLY right now. */
  freeModels: string[];
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
      tier: PROVIDER_TIERS[p.id].tier,
      tierReason: PROVIDER_TIERS[p.id].reason,
      freeModels: PROVIDER_TIERS[p.id].tier === 'free' ? freeEligibleModels(p.id) : [],
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
  freeOnly: boolean;
  models: ReturnType<typeof listModels>;
  modelSummary: ReturnType<typeof registrySummary>;
  freePlan: ReturnType<typeof aiRouter.freeModelPlan>;
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
    // FREE_ONLY is reported so the UI can say plainly whether paid models are
    // reachable at all right now.
    freeOnly: config.freeOnly,
    models: listModels(),
    modelSummary: registrySummary(),
    freePlan: aiRouter.freeModelPlan(),
  };
}

router.get('/providers', requireAuth, asyncHandler(async (_req, res) => {
  res.json(aiProviderStatus());
}));

/**
 * The model registry: which models exist, whether they are free, and what was
 * last observed. Declared attributes each carry their evidence, and a model is
 * never shown as AVAILABLE unless a real request returned 200 for it.
 */
router.get('/models', requireAuth, asyncHandler(async (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
  const freeOnly = req.query.free === 'true';
  if (provider && !isProviderId(provider)) {
    res.status(400).json({ error: 'unknown provider', allowed: PROVIDER_IDS });
    return;
  }
  res.json({
    providers: PROVIDER_TIERS,
    models: listModels({ provider: provider as ProviderId | undefined, freeOnly }),
    summary: registrySummary(),
    freeOnly: config.freeOnly,
  });
}));

/**
 * Re-reads OpenRouter's public catalogue and refreshes which registered models
 * are still priced at zero. This costs no completion quota: it is a plain read
 * of a public endpoint. Kept explicit rather than scheduled so nothing spends
 * quota on its own.
 */
router.post('/models/sync', requireAuth, asyncHandler(async (_req, res) => {
  const result = await syncOpenRouterCatalogue();
  logger.info('openrouter catalogue sync', {
    ok: result.ok, free: result.freeIds.length, total: result.totalModels, missing: result.missing.length,
  });
  res.json({
    ...result,
    error: result.error ? redact(result.error).slice(0, 300) : undefined,
    summary: registrySummary(),
  });
}));

/**
 * Live-probes one model with a real completion and records the observed status.
 * Explicitly triggered: it spends quota, so it never runs on a schedule.
 */
const modelTestSchema = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(200),
});

router.post('/models/test', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(modelTestSchema, req.body ?? {});
  if (!isProviderId(body.provider)) {
    res.status(400).json({ error: 'unknown provider', allowed: PROVIDER_IDS });
    return;
  }
  if (!MODEL_PATTERN.test(body.model)) {
    res.status(400).json({ error: 'invalid model id' });
    return;
  }
  const adapter = aiRouter.adapter(body.provider);
  if (!adapter.isConfigured()) {
    res.json({
      provider: body.provider, model: body.model, result: 'NOT_CONFIGURED',
      http: null, status: 'NOT_CONFIGURED',
      message: `${adapter.label} is not configured on the server.`,
    });
    return;
  }

  // This endpoint calls the adapter directly, so it must apply the FREE_ONLY
  // gate itself - the router is not in the path to do it.
  const refusal = freeOnlyRefusal(body.provider, body.model);
  if (refusal) {
    logger.info('ai model test blocked by FREE_ONLY', { provider: body.provider, model: body.model });
    res.json({ ...refusal, status: 'BLOCKED_BY_FREE_ONLY', http: null, durationMs: 0 });
    return;
  }

  const started = Date.now();
  const outcome = await adapter.chat({
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    model: body.model,
    maxTokens: 400,
    timeoutMs: 60_000,
  });
  const durationMs = Date.now() - started;
  const httpStatus = outcome.ok ? 200 : outcome.status ?? null;
  const observed = observeModel(body.provider, body.model, httpStatus, 'completion', outcome.ok ? null : outcome.message);

  logger.info('ai model test', { provider: body.provider, model: body.model, http: httpStatus, ok: outcome.ok, durationMs });
  res.json({
    provider: body.provider,
    model: body.model,
    result: outcome.ok ? 'PASS' : 'FAIL',
    // The status vocabulary the brief asks for, derived from the real HTTP code.
    status: observed?.status ?? classifyHttp(httpStatus),
    http: httpStatus,
    classification: outcome.ok ? null : outcome.classification ?? null,
    durationMs,
    quotaCost: 'one completion',
    reply: outcome.ok ? outcome.content.slice(0, 200) : undefined,
    message: outcome.ok ? null : redact(outcome.message).slice(0, 400),
  });
}));

/** Which free models FREE_ONLY would try right now, and which provider is skipped. */
router.get('/free-plan', requireAuth, asyncHandler(async (_req, res) => {
  res.json({
    freeOnly: config.freeOnly,
    maxFreeModelAttempts: config.aiMaxFreeModelAttempts,
    plan: aiRouter.freeModelPlan(),
  });
}));

/** The free models of one provider that FREE_ONLY may currently use. */
router.get('/free-models/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isProviderId(id)) {
    res.status(400).json({ error: 'unknown provider', allowed: PROVIDER_IDS });
    return;
  }
  res.json({
    provider: id,
    tier: PROVIDER_TIERS[id],
    eligible: freeEligibleModels(id),
    registered: listModels({ provider: id, freeOnly: true }),
  });
}));

const testSchema = z.object({
  /** Optional model override; validated against a safe pattern below. */
  model: z.string().min(1).max(200).optional(),
});

/** Model ids contain letters, digits and the punctuation providers actually use. */
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/;

/**
 * FREE_ONLY gate for the diagnostics that talk to an adapter directly rather
 * than through the router. Without this they spend real completion quota on a
 * paid provider while the rest of the system refuses to - the audit caught
 * `/providers/:id/test` and `/models/test` returning PASS from a paid provider
 * under FREE_ONLY. The policy itself lives on the router; this only shapes the
 * HTTP response body.
 */
function freeOnlyRefusal(provider: ProviderId, model?: string) {
  const refusal = aiRouter.freeOnlyRefusal(provider, model);
  if (!refusal) return null;
  return {
    provider,
    ...(model ? { model } : {}),
    result: 'BLOCKED_BY_FREE_ONLY',
    code: refusal.code,
    freeOnly: true,
    quotaCost: 'none',
    message: refusal.message,
  };
}

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

  // This endpoint calls the adapter directly, so it must apply the FREE_ONLY
  // gate itself - the router is not in the path to do it.
  const refusal = freeOnlyRefusal(id, body.model);
  if (refusal) {
    logger.info('ai provider test blocked by FREE_ONLY', { provider: id });
    res.status(200).json({ ...refusal, label: adapter.label, http: null, durationMs: 0 });
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
