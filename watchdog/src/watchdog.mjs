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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log, redact } from './log.mjs';
import { VERDICT, checkStudioHealth, loadSettings, readStudioUrl } from './discovery.mjs';
import { OpenHandsClient } from './openhandsClient.mjs';
import { REPO_BRANCH, recoverStudio } from './recovery.mjs';
import { evaluateBudget, readState, recordRebuild, writeState } from './state.mjs';

/** The only file an automated publish is ever allowed to touch. */
const URL_JSON_FILE = 'url.json';

/**
 * Builds a publish failure. Carrying a stage lets the caller tell "the watchdog
 * could not do its job" apart from "the studio looks unwell", which are the two
 * outcomes a human reacts to differently.
 */
function publishFailure(message) {
  const err = new Error(message);
  err.stage = 'publish';
  return err;
}

/**
 * Runs one git command in the repository, capturing its output rather than
 * inheriting this process's stdio.
 *
 * Capturing matters for two reasons here. The token is injected by the checkout
 * action into the remote's configuration, not into a command line, so nothing
 * needs to be echoed; and a command that prints a credential on failure would go
 * straight into the CI transcript if stdio were inherited. What is captured is
 * put through the same redaction every log line gets.
 */
function runGit(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr: redact(stderr) }));
  });
}

/**
 * Publishes the new URL by writing url.json, then committing and pushing exactly
 * that file.
 *
 * The commit and the push are part of publishing, not a follow-up. url.json is
 * only useful once it is on the branch every installed APK reads, so a push that
 * is rejected is a publish that failed rather than a detail to log and forget.
 * Everything here throws on failure, which the recovery already treats like any
 * other step failure - including discarding the sandbox it created, so a rejected
 * push cannot leave a runtime behind.
 *
 * What is deliberately not done: no `git add .`, no `git add -A`. Only url.json
 * is ever staged, and a commit is refused outright if anything else turns up
 * staged, because an automated commit that swallowed a stray edit would be worse
 * than no commit at all.
 */
export function makePublisher({ repoRoot, dryRun }) {
  return async (url) => {
    if (dryRun) {
      log.warn('dry-run: would publish url.json', { url });
      return;
    }

    // The step 2 publisher writes url.json and re-verifies /api/health itself, so
    // a URL that stopped answering since the recovery probed it is never recorded.
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [`${repoRoot}/scripts/url-json-update.mjs`, '--url', url, '--status', 'online'],
        { stdio: 'inherit', env: process.env },
      );
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(publishFailure(`url-json-update.mjs exited ${code}`)),
      );
    });

    const env = {
      ...process.env,
      // Never fall back to a credential prompt. In a runner there is no terminal
      // to prompt, so a rejected push would otherwise consume its retries and
      // still not fail the step.
      GIT_TERMINAL_PROMPT: '0',
    };

    // actions/checkout does not guarantee a committer identity, and without one
    // `git commit` fails with "Author identity unknown" - an automated publish
    // that never lands. `git config user.email` exits 1 when the value is unset
    // and 0 with empty output when it is set to nothing, so both have to count as
    // "missing". It is set only in this repository's local config, so a
    // developer's own identity is never overwritten.
    const email = await runGit(['config', 'user.email'], { cwd: repoRoot, env });
    if (email.code !== 0 || email.stdout.trim() === '') {
      await runGit(['config', 'user.name', 'my-ai-studio watchdog'], { cwd: repoRoot, env });
      // A GitHub noreply-style address: no personal mailbox is invented, and the
      // commit is visibly attributable to the automation that made it.
      await runGit(['config', 'user.email', 'watchdog@users.noreply.github.com'], { cwd: repoRoot, env });
      log.info('set a local committer identity for the automated publish');
    }

    const added = await runGit(['add', '--', URL_JSON_FILE], { cwd: repoRoot, env });
    if (added.code !== 0) {
      throw publishFailure(`git add ${URL_JSON_FILE} failed: ${added.stderr.trim() || added.code}`);
    }

    // Exactly what would be committed, checked rather than assumed.
    const staged = await runGit(['diff', '--cached', '--name-only'], { cwd: repoRoot, env });
    if (staged.code !== 0) {
      throw publishFailure(`could not read the staged files: ${staged.stderr.trim() || staged.code}`);
    }
    const files = staged.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    const foreign = files.filter((file) => file !== URL_JSON_FILE);
    if (foreign.length > 0) {
      // Put the tree back exactly as it was found before reporting, so the next
      // run starts from a clean state instead of inheriting our half-done stage.
      await runGit(['reset', '--quiet'], { cwd: repoRoot, env });
      await runGit(['checkout', '--', URL_JSON_FILE], { cwd: repoRoot, env });
      throw publishFailure(
        `refusing to commit files other than ${URL_JSON_FILE}: ${foreign.join(', ')}`,
      );
    }

    if (files.length === 0) {
      // url.json already carries this URL and status; url-json-update.mjs reports
      // that case without rewriting the file. Nothing to publish.
      log.info('url.json is already current; nothing to commit', { url });
      return;
    }

    // The message names the new address, which is public by design, and nothing
    // else. `--only` narrows the commit to url.json even though the index was
    // just checked, so a change that slipped in between the two cannot ride along.
    const commit = await runGit(
      ['commit', '--only', '--message', `chore(watchdog): publish studio url ${url}`, '--', URL_JSON_FILE],
      { cwd: repoRoot, env },
    );
    if (commit.code !== 0) {
      throw publishFailure(`git commit failed: ${commit.stderr.trim() || commit.code}`);
    }

    // A commit hash is not a secret and is what makes the publish traceable from
    // the CI output alone.
    const head = await runGit(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, env });
    log.info('committed the published url', { commit: head.stdout.trim() });

    const pushed = await runGit(['push', 'origin', `HEAD:${REPO_BRANCH}`], { cwd: repoRoot, env });
    if (pushed.code !== 0) {
      // The branch is explicit rather than relying on upstream tracking, so a
      // detached HEAD in CI still pushes to the branch the APKs read.
      throw publishFailure(`git push to ${REPO_BRANCH} failed: ${pushed.stderr.trim() || pushed.code}`);
    }
    log.info('pushed the published url', { branch: REPO_BRANCH });
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

/**
 * The repository root, derived from this file's location.
 *
 * This file lives in watchdog/src/, so the root is two levels up. `..` alone
 * resolved to watchdog/, and the publisher then looked for
 * watchdog/scripts/url-json-update.mjs, which does not exist: the recovery
 * rebuilt the studio and then failed at the publish step with MODULE_NOT_FOUND.
 * Every test passed --repo-root explicitly, so the default was never exercised.
 */
export function defaultRepoRoot() {
  return fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
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
  const repoRoot = values['repo-root'] || defaultRepoRoot();

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
