#!/usr/bin/env node
/**
 * External watchdog for My AI Studio.
 *
 * One cycle:
 *
 *   read url.json -> probe /api/health (with retries)
 *     alive   -> do nothing at all
 *     dead    -> rebuild a runtime, verify it publicly, publish the new URL
 *     unknown -> do nothing, log, and let the next cycle decide
 *
 * The watchdog lives outside the studio on purpose. A supervisor running inside
 * the runtime it supervises cannot restart that runtime, because the thing that
 * would perform the restart is the thing that died. Nothing here imports studio
 * code, and nothing here is reachable from the studio: the two only meet through
 * the committed url.json and the OpenHands API.
 *
 * Running it with --plan performs the detection half only and never creates a
 * sandbox, which is what a scheduled job should use when it is not certain it
 * wants to spend quota.
 */

import { parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from './log.mjs';
import { VERDICT, checkStudioHealth, loadSettings, readStudioUrl } from './discovery.mjs';
import { OpenHandsClient } from './openhandsClient.mjs';
import { recoverStudio } from './recovery.mjs';
import { evaluateBudget, readState, recordRebuild, writeState } from './state.mjs';

/** Publishes the new URL by invoking the step 2 publisher, which re-verifies it. */
function makePublisher({ repoRoot, dryRun }) {
  return async (url) => {
    if (dryRun) {
      log.warn('dry-run: would publish url.json', { url });
      return;
    }
    const { spawn } = await import('node:child_process');
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [`${repoRoot}/scripts/url-json-update.mjs`, '--url', url, '--status', 'online'],
        { stdio: 'inherit', env: process.env },
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`url-json-update.mjs exited ${code}`)),
      );
    });
  };
}

export async function runCycle({
  settings,
  planOnly = false,
  client,
  healthProbe,
  publish,
  sleep,
  readDocument,
} = {}) {
  const started = Date.now();
  log.info('cycle started', { planOnly });

  const { url, updatedAt } = await (readDocument ?? readStudioUrl)(settings);
  log.info('studio address read', { url, documentUpdatedAt: updatedAt });

  const probe = healthProbe ?? ((base) => checkStudioHealth(base, settings, { sleep }));
  const health = await probe(url);

  if (health.verdict === VERDICT.ALIVE) {
    // The studio is fine: nothing is created, nothing is changed.
    log.info('studio is alive; nothing to do', { url, detail: health.detail });
    return { action: 'none', verdict: health.verdict, url };
  }

  if (health.verdict === VERDICT.UNKNOWN) {
    // Not conclusive. Rebuilding on this would churn runtimes for a blip, so the
    // cycle ends and the next one re-checks.
    log.warn('studio did not answer conclusively; leaving it alone', {
      url,
      detail: health.detail,
      attempts: health.attempts?.length,
    });
    return { action: 'none', verdict: health.verdict, url, detail: health.detail };
  }

  log.error('studio is dead', { url, detail: health.detail });
  if (planOnly) {
    log.warn('plan-only: would rebuild now, but no sandbox was created');
    return { action: 'would-rebuild', verdict: health.verdict, url, detail: health.detail };
  }

  const state = await readState(settings.statePath);
  const budget = evaluateBudget(state, settings);
  if (!budget.allowed) {
    log.error('refusing to rebuild', { reason: budget.reason });
    return { action: 'blocked', verdict: health.verdict, url, reason: budget.reason };
  }

  const recovery = await recoverStudio({ client, publish, sleep, healthProbe: probe });
  log.info('cycle finished', { action: 'rebuilt', url: recovery.publicUrl, ms: Date.now() - started });

  const next = recordRebuild(state, { url: recovery.publicUrl, sandboxId: recovery.sandboxId });
  await writeState(settings.statePath, next);

  return { action: 'rebuilt', verdict: health.verdict, url: recovery.publicUrl, previousUrl: url };
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'repo-root': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(
      [
        'Usage: node src/watchdog.mjs [--plan] [--dry-run] [--repo-root DIR]',
        '',
        '  --plan      detect only; never creates a sandbox',
        '  --dry-run   do everything except write url.json',
        '',
        'Environment: OPENHANDS_API_KEY (required to rebuild),',
        '  WATCHDOG_HEALTH_ATTEMPTS, WATCHDOG_HEALTH_DELAY_MS,',
        '  WATCHDOG_MAX_REBUILDS_PER_DAY, WATCHDOG_STATE_PATH',
        '',
      ].join('\n'),
    );
    return;
  }

  const settings = loadSettings();
  const repoRoot = values['repo-root'] || new URL('..', import.meta.url).pathname.replace(/\/$/, '');

  const result = await runCycle({
    settings,
    planOnly: values.plan,
    client: values.plan ? undefined : new OpenHandsClient(),
    publish: makePublisher({ repoRoot, dryRun: values['dry-run'] }),
  });

  // Exit codes are what an external scheduler acts on: 0 healthy, 2 a runtime
  // was replaced or is about to be, 1 anything that needs a human to look.
  //
  // plan-only shares rebuild's code on purpose. A caller that gates recovery on
  // "the check did not say healthy" - the workflow does exactly that with
  // exit_code != '0' - must see the same signal whether the rebuild was
  // performed or merely planned, otherwise a dead studio reads as healthy and
  // the recovery it was meant to trigger never runs.
  if (result.action === 'rebuilt' || result.action === 'would-rebuild') process.exitCode = 2;
  else if (result.action === 'blocked') process.exitCode = 1;
}

// Only run when invoked directly, so tests can import runCycle.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    log.error('watchdog failed', { error: err instanceof Error ? err.message : String(err), stage: err?.stage });
    process.exitCode = 1;
  });
}

export { main };
