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
import { getGithubStatus, downloadArtifact } from '../services/githubActions.ts';
import { requireAuth, requireAdmin } from '../middleware/auth.ts';
import {
  credentialInfo,
  clearStoredCredential,
  saveStoredCredential,
  validateTokenShape,
  matchesStored,
  probeCredential,
} from '../services/githubCredential.ts';
import { z } from 'zod';
import { validate, HttpError } from '../middleware/validate.ts';
import { audit } from '../services/projects.ts';
import { isDatabaseConfigured } from '../db/pool.ts';

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

// The Android emulator probe endpoint (GET /api/system/emulator) was removed
// along with the emulator preview. The emulator/adb state is no longer part of
// the system status; see ARCHITECTURE.md.

router.get('/system/github', requireAuth, asyncHandler(async (_req, res) => {
  const status = await getGithubStatus();
  res.json(status);
}));

/**
 * The GitHub credential My AI Studio itself uses.
 *
 * Returns only non-secret facts: which source is in play, a short fingerprint
 * that identifies a credential without revealing it, and its shape. The token
 * is never included, in any form, on any path.
 */
router.get('/system/github/credential', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
  const info = credentialInfo();
  res.json({
    configured: info.configured,
    source: info.source,
    fingerprint: info.fingerprint,
    tokenKind: info.tokenKind,
    repo: info.repo,
    updatedAt: info.updatedAt,
    // A deployment-supplied value cannot be changed here; the UI uses this to
    // explain why the form may be overridden.
    editable: info.source === 'database' || info.source === 'none',
    databaseConfigured: isDatabaseConfigured(),
    envVariable: 'MY_AI_STUDIO_GITHUB_TOKEN',
    detail: describeCredentialSource(info.source),
  });
}));

function describeCredentialSource(source: string): string {
  switch (source) {
    case 'database':
      return 'using the credential stored in My AI Studio';
    case 'env':
      return 'using MY_AI_STUDIO_GITHUB_TOKEN from the deployment environment';
    case 'app':
      return 'using a GitHub App installation token';
    default:
      return 'no GitHub credential is configured; publishing and Android builds are NOT AVAILABLE until one is set';
  }
}

const credentialSchema = z.object({
  // Bounded so an oversized body cannot be used to exhaust memory, and trimmed
  // so a pasted trailing newline does not become part of the secret.
  token: z.string().min(20).max(512),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo must be owner/name').optional(),
});

/**
 * Stores or replaces the credential. Admin only. The value is encrypted before
 * it is written, and the response echoes a fingerprint rather than the token.
 */
router.put('/system/github/credential', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!isDatabaseConfigured()) {
    throw new HttpError(503, 'DATABASE_URL is not configured on the server, so a credential cannot be stored', 'database_not_configured');
  }
  const body = validate(credentialSchema, req.body);
  const shapeError = validateTokenShape(body.token);
  if (shapeError) {
    await audit({ userId: req.user?.id, action: 'github.credential.set', outcome: 'invalid', ip: req.ip ?? null });
    throw new HttpError(400, shapeError, 'invalid_credential');
  }
  const info = await saveStoredCredential(body.token, body.repo ?? null, req.user?.id ?? null);
  await audit({
    userId: req.user?.id,
    action: 'github.credential.set',
    ip: req.ip ?? null,
    detail: { fingerprint: info.fingerprint, tokenKind: info.tokenKind, repo: info.repo },
  });
  // Prove the credential against the live repository so the operator learns
  // immediately whether it can actually write, rather than on the next build.
  const status = await getGithubStatus();
  res.json({
    ok: true,
    fingerprint: info.fingerprint,
    tokenKind: info.tokenKind,
    source: info.source,
    status,
  });
}));

/** Removes the stored credential, falling back to the environment if present. */
router.delete('/system/github/credential', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!isDatabaseConfigured()) {
    throw new HttpError(503, 'DATABASE_URL is not configured on the server', 'database_not_configured');
  }
  const info = await clearStoredCredential();
  await audit({ userId: req.user?.id, action: 'github.credential.clear', ip: req.ip ?? null });
  res.json({ ok: true, source: info.source, configured: info.configured });
}));

/**
 * Verifies a candidate credential against GitHub without storing it. Used by
 * the admin panel to test a token before committing it, and to confirm that a
 * pasted value matches what is already stored without either being displayed.
 */
router.post('/system/github/credential/test', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const body = validate(credentialSchema, req.body);
  const shapeError = validateTokenShape(body.token);
  if (shapeError) throw new HttpError(400, shapeError, 'invalid_credential');
  const probe = await probeCredential(body.token, body.repo ?? credentialInfo().repo);
  await audit({
    userId: req.user?.id,
    action: 'github.credential.test',
    outcome: probe.ok ? 'ok' : 'failed',
    ip: req.ip ?? null,
    detail: { canWrite: probe.canWrite, login: probe.login ?? null },
  });
  res.json({
    ...probe,
    matchesStored: matchesStored(body.token),
  });
}));

/**
 * Artifacts of the latest run of the configured repository. Kept for the
 * read-only status panel; the project-scoped build routes under
 * /api/projects/:id/github/* are the path the Build Center uses.
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
