import { Router } from 'express';
import { asyncHandler } from '../middleware/validate.ts';
import { getSystemStatus } from '../services/systemStatus.ts';
import { config } from '../config/index.ts';
import { openRouter } from '../services/openrouter.ts';
import { jobQueue } from '../services/jobQueue.ts';
import { eventBus } from '../services/eventBus.ts';
import { checkDatabase } from '../db/pool.ts';
import { checkEmulator } from '../services/androidPreview.ts';

const router = Router();

/** Cheap liveness probe. Contains no secrets and no infrastructure detail. */
router.get('/health', asyncHandler(async (_req, res) => {
  res.json({
    ok: true,
    service: 'my-ai-studio',
    version: '1.0.0',
    openrouter: openRouter.isConfigured() ? 'configured' : 'not_configured',
    time: new Date().toISOString(),
  });
}));

/**
 * Readiness probe: reports whether each dependency is reachable. Only booleans
 * and status strings are exposed - never a key, URL with credentials or error
 * dump that could carry one.
 */
router.get('/health/ready', asyncHandler(async (_req, res) => {
  const db = await checkDatabase();
  const ready = db.connected && openRouter.isConfigured();
  res.status(ready ? 200 : 503).json({
    ok: ready,
    checks: {
      database: db.configured ? (db.connected ? 'UP' : 'DOWN') : 'NOT_CONFIGURED',
      openrouter: openRouter.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
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
