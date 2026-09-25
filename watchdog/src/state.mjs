/**
 * Guards against rebuild loops.
 *
 * The failure this prevents is not a single bad rebuild, it is an unattended
 * watchdog that rebuilds every time it runs: a studio that cannot start for a
 * reason no rebuild will fix (a missing repository secret, a GitHub outage)
 * would otherwise consume the sandbox quota until nothing is left.
 *
 * Two limits, both from the settings rather than hardcoded:
 *
 *  - a daily budget of rebuilds, so a persistently broken studio stops burning
 *    quota and the failure is visible in the log instead;
 *  - a minimum gap between rebuilds, so a run that fails immediately cannot be
 *    retried in a tight loop by an external scheduler.
 *
 * The state file is written atomically because two runs can overlap.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from './log.mjs';

const DEFAULT_STATE = { rebuilds: [] };

export function emptyState() {
  return { rebuilds: [] };
}

/** Rebuilds within the last 24 hours. */
export function recentRebuilds(state, now = Date.now()) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  return (state?.rebuilds ?? []).filter((entry) => {
    const at = Date.parse(entry?.at ?? '');
    return Number.isFinite(at) && at >= cutoff;
  });
}

export function evaluateBudget(state, settings, now = Date.now()) {
  const recent = recentRebuilds(state, now);
  if (recent.length >= settings.maxRebuildsPerDay) {
    return {
      allowed: false,
      reason: `daily rebuild budget exhausted (${recent.length}/${settings.maxRebuildsPerDay} in 24h)`,
      recent,
    };
  }
  const last = recent.at(-1);
  if (last) {
    const elapsed = now - Date.parse(last.at);
    const gap = settings.minRebuildGapMs ?? 0;
    if (elapsed < gap) {
      const waitMs = gap - elapsed;
      return {
        allowed: false,
        reason: `last rebuild was ${Math.round(elapsed / 1000)}s ago; waiting ${Math.round(waitMs / 1000)}s more`,
        recent,
        waitMs,
      };
    }
  }
  return { allowed: true, recent };
}

export async function readState(path) {
  if (!path) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed?.rebuilds) ? { rebuilds: parsed.rebuilds } : emptyState();
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyState();
    // A corrupt state file must not silently disable the guard: treat it as
    // empty but say so, so the cause is visible.
    log.warn('could not read watchdog state; starting from empty', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return emptyState();
  }
}

export async function writeState(path, state) {
  if (!path) return;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const temp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  // Write then rename so a reader never sees a half-written file.
  await writeFile(temp, payload, 'utf8');
  await rename(temp, path);
}

export function recordRebuild(state, { url, sandboxId, at = new Date().toISOString() }) {
  // Only the outcome is kept; the state file must never hold a credential.
  return { rebuilds: [...(state?.rebuilds ?? []), { at, url, sandboxId }].slice(-50) };
}
