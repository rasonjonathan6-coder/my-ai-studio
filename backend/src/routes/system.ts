import { Router } from 'express';
import { asyncHandler } from '../middleware/validate.ts';
import { getSystemStatus } from '../services/systemStatus.ts';
import { config } from '../config/index.ts';
import { openRouter } from '../services/openrouter.ts';
import { aiRouter } from '../services/aiProvider.ts';
import { PROVIDER_TIERS, registrySummary } from '../services/modelRegistry.ts';
import { aiProviderStatus } from './ai.ts';
import { jobQueue } from '../services/jobQueue.ts';
import { eventBus } from '../services/eventBus.ts';
import { checkDatabase } from '../db/pool.ts';
import { checkEmulator } from '../services/androidPreview.ts';
import { getGithubStatus, downloadArtifact } from '../services/githubActions.ts';
import { requireAuth } from '../middleware/auth.ts';

const router = Router();

/**
 * Configuration state of every AI provider, as `id -> configured|not_configured`.
 * Configuration is a fact about the server environment only: no provider is
 * ever reported as connected here, because only a real request proves that.
 */
function providerConfigState(): Record<string, 'configured' | 'not_configured'> {
  const state: Record<string, 'configured' | 'not_configured'> = {};
  for (const provider of aiRouter.providers()) {
    state[provider.id] = provider.status().configured ? 'configured' : 'not_configured';
  }
  return state;
}

/** Cheap liveness probe. Contains no secrets and no infrastructure detail. */
router.get('/health', asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    service: 'my-ai-studio',
    version: '1.0.0',
    // Kept for existing clients that read this single field.
    openrouter: openRouter.isConfigured() ? 'configured' : 'not_configured',
    providers: providerConfigState(),
    // Whether the paid providers are reachable at all. Reported so a caller can
    // tell a "no free model worked" failure from a total outage.
    freeOnly: config.freeOnly,
    free: {
      providers: (Object.entries(PROVIDER_TIERS) as Array<[string, { tier: string }]>)
        .filter(([, v]) => v.tier === 'free').map(([k]) => k),
      paidExcluded: (Object.entries(PROVIDER_TIERS) as Array<[string, { tier: string }]>)
        .filter(([, v]) => v.tier === 'paid').map(([k]) => k),
      freeModels: registrySummary().freeModels,
    },
    time: new Date().toISOString(),
  });
}));

/**
 * The readiness rule, as a pure function so it can be exercised for a
 * Gemini-only deployment without standing up that environment.
 */
export function isReady(
  dbConnected: boolean,
  providers: Record<string, 'configured' | 'not_configured'>,
): boolean {
  const anyProviderConfigured = Object.values(providers).some((s) => s === 'configured');
  return dbConnected && anyProviderConfigured;
}

/**
 * Readiness probe: reports whether each dependency is reachable. Only booleans
 * and status strings are exposed - never a key, URL with credentials or error
 * dump that could carry one.
 */
router.get('/health/ready', asyncHandler(async (_req, res) => {
  const db = await checkDatabase();
  const providers = providerConfigState();
  // Readiness means "a run can be served". Any single configured provider is
  // enough, so a missing OpenRouter key must not report the service as down
  // while Gemini can still answer.
  const ready = isReady(db.connected, providers);
  res.status(ready ? 200 : 503).json({
    ok: ready,
    checks: {
      database: db.configured ? (db.connected ? 'UP' : 'DOWN') : 'NOT_CONFIGURED',
      openrouter: openRouter.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
      providers,
    },
    time: new Date().toISOString(),
  });
}));

router.get('/system/status', asyncHandler(async (_req, res) => {
  const status = await getSystemStatus();
  res.json({ ...status, jobs: { active: jobQueue.active, pending: jobQueue.pending, max: config.maxConcurrentJobs } });
}));

/** Detailed diagnostics. Requires authentication because it reveals host paths. */
router.get('/system/info', asyncHandler(async (_req, res) => {
  const status = await getSystemStatus();
  res.json({
    ...status,
    jobs: { active: jobQueue.active, pending: jobQueue.pending, max: config.maxConcurrentJobs },
    config: {
      env: config.env,
      maxFixAttempts: config.maxFixAttempts,
      commandTimeoutMs: config.commandTimeoutMs,
      buildTimeoutMs: config.buildTimeoutMs,
      agentTimeoutMs: config.agentTimeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      maxFileBytes: config.maxFileBytes,
      maxConcurrentJobs: config.maxConcurrentJobs,
      sandboxEnabled: config.sandbox.enabled,
      sandboxImage: config.sandbox.image,
      openRouterModel: config.openRouterModel,
      workspaceRoot: config.workspaceRoot,
      storageRoot: config.storageRoot,
      jwtSecretGenerated: config.jwtSecretWasGenerated,
    },
    // The same provider view the AI screen consumes, so an operator can see the
    // gateway state without a second authenticated call. Key values never appear.
    aiProviders: aiProviderStatus(),
    websocketSubscribers: eventBus.channelSize('__total__'),
  });
}));

router.get('/system/emulator', asyncHandler(async (_req, res) => {
  const emulator = await checkEmulator();
  res.json({
    ...emulator,
    status: emulator.available ? 'AVAILABLE' : 'NOT_AVAILABLE',
    note: emulator.available
      ? 'An emulator/device is reachable through adb.'
      : 'No emulator is attached. Android preview and instrumentation tests are NOT AVAILABLE in this environment.',
  });
}));

router.get('/system/github', requireAuth, asyncHandler(async (_req, res) => {
  const status = await getGithubStatus();
  res.json(status);
}));

/**
 * Proxies a GitHub Actions artifact through the backend so the token is never
 * handed to the browser. Requires authentication: the route is mounted under
 * the same auth middleware as the rest of the API.
 */
router.get('/system/github/artifacts/:artifactId', requireAuth, asyncHandler(async (req, res) => {
  const raw = String(req.params.artifactId ?? '');
  const artifactId = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) {
    res.status(400).json({ error: 'artifactId must be a positive integer' });
    return;
  }
  const status = await getGithubStatus();
  if (!status.connected || !status.repo) {
    res.status(503).json({ error: 'GitHub integration is not available', detail: status.detail });
    return;
  }
  // Only artifacts belonging to the repository's latest run are servable, which
  // keeps the route from becoming an arbitrary fetch proxy.
  if (!status.latestArtifacts.some((a) => a.id === artifactId)) {
    res.status(404).json({ error: 'artifact does not belong to the latest workflow run of the configured repository' });
    return;
  }
  const artifact = status.latestArtifacts.find((a) => a.id === artifactId);
  if (artifact?.expired) {
    res.status(410).json({ error: 'artifact has expired' });
    return;
  }
  const result = await downloadArtifact(status.repo, artifactId);
  if (!result.ok || !result.body) {
    res.status(502).json({ error: 'artifact download failed', detail: result.error ?? null });
    return;
  }
  res.setHeader('Content-Type', result.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${artifact?.name ?? 'artifact'}.zip"`);
  const reader = result.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}));

export default router;
