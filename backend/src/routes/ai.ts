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
import { aiRouter, PROVIDER_IDS, isProviderId, type ProviderId } from '../services/aiProvider.ts';
import { logger, redact } from '../lib/logger.ts';

const router = Router();

function providerSummary(): Array<{
  id: ProviderId;
  label: string;
  configured: boolean;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  connection: 'NOT_TESTED';
  model: string | null;
  endpoint: string;
  cooling: boolean;
  cooldownUntil: string | null;
  cooldownReason: string | null;
}> {
  const cooldowns = aiRouter.cooldownState();
  return aiRouter.providers().map((p) => {
    const s = p.status();
    const c = cooldowns[p.id];
    return {
      id: p.id,
      label: p.label,
      configured: s.configured,
      status: s.configured ? 'CONFIGURED' as const : 'NOT_CONFIGURED' as const,
      // Connection is only proven by a real request through the test endpoint.
      connection: 'NOT_TESTED' as const,
      model: s.model || null,
      endpoint: s.baseUrl,
      cooling: c.cooling,
      cooldownUntil: c.until,
      cooldownReason: c.reason,
    };
  });
}

/** Shared by /api/ai/providers and /api/system/info. */
export function aiProviderStatus(): {
  defaultProvider: string;
  order: string[];
  cooldownMs: number;
  providers: ReturnType<typeof providerSummary>;
  auto: ReturnType<typeof aiRouter.autoOrder>;
  recentAttempts: ReturnType<typeof aiRouter.recentAttempts>;
} {
  // The auto view is also used to drive the frontend selector, so paths are
  // reported per provider and no request is made here.
  return {
    defaultProvider: config.aiDefaultProvider,
    order: aiRouter.autoOrder().ready.concat(aiRouter.autoOrder().cooling, aiRouter.autoOrder().unconfigured),
    cooldownMs: config.aiProviderCooldownMs,
    providers: providerSummary(),
    auto: aiRouter.autoOrder(),
    recentAttempts: aiRouter.recentAttempts(),
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
    logger.info('ai provider test', { provider: id, http: 200, durationMs, model: outcome.model });
    res.json({
      provider: id,
      label: adapter.label,
      result: 'PASS',
      model: outcome.model,
      endpoint: status.baseUrl,
      http: 200,
      durationMs,
      usage: outcome.usage,
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
    attempts: outcome.attempts,
    message: outcome.ok ? null : redact(outcome.message).slice(0, 500),
  });
}));

export default router;
