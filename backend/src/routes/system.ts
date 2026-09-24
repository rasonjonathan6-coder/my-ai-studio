import { Router } from 'express';
import { asyncHandler } from '../middleware/validate.ts';
import { getSystemStatus } from '../services/systemStatus.ts';
import { config } from '../config/index.ts';
import { openRouter } from '../services/openrouter.ts';
import { aiRouter } from '../services/aiProvider.ts';
import { aiProviderStatus } from './ai.ts';
import { jobQueue } from '../services/jobQueue.ts';
import { eventBus } from '../services/eventBus.ts';
import { checkDatabase } from '../db/pool.ts';
import { checkEmulator } from '../services/androidPreview.ts';

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

export default router;
