/**
 * Reading the published url.json and deciding whether the studio it names is
 * actually alive.
 *
 * url.json is the only source of truth for where the studio runs. Nothing here
 * may hardcode a host: the whole point of the file is that the address changes
 * when a runtime is replaced, and a hardcoded fallback would quietly defeat it.
 *
 * The difficult judgement is "dead" versus "having a bad minute". A laptop that
 * slept, a DNS hiccup or a deploy restarting the process all look like a failure
 * on a single probe, and rebuilding a runtime for any of them would churn
 * sandboxes and publish a new URL that is no better than the old one. So a
 * failure only becomes a verdict after several attempts spread over time, and
 * only a definite answer (a 404 from a host that is up, a wrong service name)
 * short-circuits that.
 */

import { log } from './log.mjs';

const DEFAULT_DOCUMENT_URL =
  'https://raw.githubusercontent.com/rasonjonathan6-coder/my-ai-studio/main/url.json';

/** A response that proves the host is serving something, but not the studio. */
export const VERDICT = {
  ALIVE: 'alive',
  DEAD: 'dead',
  UNKNOWN: 'unknown',
};

export class ConfigError extends Error {}

function intFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

export function loadSettings() {
  return {
    documentUrl: process.env.URL_JSON_URL || DEFAULT_DOCUMENT_URL,
    // Retries and their spacing decide how a transient failure is treated. The
    // defaults give roughly a minute of grace before a rebuild is considered.
    healthAttempts: intFromEnv('WATCHDOG_HEALTH_ATTEMPTS', 4, { min: 1, max: 20 }),
    healthDelayMs: intFromEnv('WATCHDOG_HEALTH_DELAY_MS', 5_000, { min: 0, max: 300_000 }),
    healthTimeoutMs: intFromEnv('WATCHDOG_HEALTH_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 }),
    documentTimeoutMs: intFromEnv('WATCHDOG_DOCUMENT_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 }),
    // Below this, a failure is still treated as possibly transient even after
    // every attempt failed, because no failure was conclusive.
    maxRebuildsPerDay: intFromEnv('WATCHDOG_MAX_REBUILDS_PER_DAY', 4, { min: 1, max: 48 }),
    // A run that fails immediately must not be retried in a tight loop by
    // whatever schedules it.
    minRebuildGapMs: intFromEnv('WATCHDOG_MIN_REBUILD_GAP_MS', 600_000, { min: 0, max: 86_400_000 }),
    statePath: process.env.WATCHDOG_STATE_PATH || '',
  };
}

async function fetchWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'my-ai-studio-watchdog', ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads and validates the discovery document. Returns the studio URL, or throws
 * with a reason. It deliberately does not fall back to a default host: an
 * unreadable document means we do not know where the studio is, and guessing
 * could point the watchdog at an unrelated service.
 */
export async function readStudioUrl(settings, fetchImpl = fetchWithTimeout) {
  const { documentUrl, documentTimeoutMs } = settings;

  let res;
  try {
    res = await fetchImpl(documentUrl, documentTimeoutMs, { 'cache-control': 'no-cache' });
  } catch (err) {
    throw new Error(`could not read ${documentUrl}: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) throw new Error(`could not read ${documentUrl}: HTTP ${res.status}`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`discovery document is not valid JSON: ${documentUrl}`);
  }

  if (body?.service !== 'my-ai-studio') {
    throw new Error(`discovery document is not for this service (service=${String(body?.service)})`);
  }
  if (body?.schema !== 1) {
    throw new Error(`unsupported discovery schema: ${String(body?.schema)}`);
  }

  const raw = typeof body.url === 'string' ? body.url.trim() : '';
  if (!raw) throw new Error('discovery document has no url');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`discovery document url is not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`discovery document url is not http(s): ${parsed.protocol}`);
  }
  if (!parsed.hostname) throw new Error('discovery document url has no host');

  return {
    // Reduced to an origin because callers append /api/... to it.
    url: parsed.origin,
    documentUrl,
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : null,
    status: typeof body.status === 'string' ? body.status : null,
  };
}

/**
 * Probes one base URL once. Distinguishes "not the studio" from "not reachable"
 * because only the former is conclusive.
 */
export async function probeOnce(baseUrl, settings, fetchImpl = fetchWithTimeout) {
  const { healthTimeoutMs } = settings;
  const target = `${baseUrl}/api/health`;
  try {
    const res = await fetchImpl(target, healthTimeoutMs, { 'cache-control': 'no-cache' });
    if (res.status === 404) {
      // The host answered and has no studio route: this is not a network blip.
      return { ok: false, conclusive: true, detail: `health returned HTTP 404 at ${target}` };
    }
    if (!res.ok) {
      return { ok: false, conclusive: false, detail: `health returned HTTP ${res.status}` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, conclusive: true, detail: 'health did not return JSON' };
    }
    if (body?.service !== 'my-ai-studio') {
      return {
        ok: false,
        conclusive: true,
        detail: `health reported service=${String(body?.service)}`,
      };
    }
    if (body?.ok !== true) {
      // The studio is up but not healthy. That is its own problem to report and
      // not something a fresh runtime would fix.
      return { ok: false, conclusive: false, detail: `health reported ok=${String(body?.ok)}` };
    }
    return { ok: true, detail: `service=${body.service} version=${body.version ?? 'n/a'}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, conclusive: false, detail: `unreachable: ${reason}` };
  }
}

/**
 * Probes with retries and returns a verdict. `conclusive` failures stop the
 * retry loop early: repeating a request that already proved the host is serving
 * the wrong thing only wastes time.
 */
export async function checkStudioHealth(baseUrl, settings, { sleep, fetchImpl, onAttempt } = {}) {
  const doSleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { healthAttempts, healthDelayMs } = settings;
  const attempts = [];

  for (let attempt = 1; attempt <= healthAttempts; attempt += 1) {
    const result = await probeOnce(baseUrl, settings, fetchImpl ?? fetchWithTimeout);
    attempts.push({ attempt, ...result });
    if (onAttempt) onAttempt({ attempt, ...result });

    if (result.ok) return { verdict: VERDICT.ALIVE, attempts, detail: result.detail };
    if (result.conclusive) return { verdict: VERDICT.DEAD, attempts, detail: result.detail };

    if (attempt < healthAttempts) {
      // Back off linearly; a burst of retries would not survive a restart.
      await doSleep(healthDelayMs * attempt);
    }
  }

  // Every attempt failed, but none conclusively. The host may simply be having a
  // bad minute, so this is not yet grounds to rebuild.
  return {
    verdict: VERDICT.UNKNOWN,
    attempts,
    detail: `no conclusive answer after ${healthAttempts} attempts (last: ${attempts.at(-1)?.detail})`,
  };
}

export { DEFAULT_DOCUMENT_URL, log };
