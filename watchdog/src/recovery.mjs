/**
 * Recovering My AI Studio into a fresh OpenHands sandbox.
 *
 * Every step here was run by hand against the live API before being written
 * down, so the commands are known to work rather than assumed to:
 * clone, install, build, start on the exposed port, and answer /api/health from
 * the public URL. That last check is the point of the whole file: a sandbox that
 * runs the server but cannot be reached is not a recovery.
 *
 * Two things are deliberately not done here:
 *
 *  - No secret is copied from this process into the new runtime. The JWT secret
 *    the studio requires is generated fresh inside the sandbox. A recovered
 *    runtime that inherited a signing key from a dead one would let old tokens
 *    keep working, which is worse than invalidating them.
 *  - Nothing is published until the public URL has answered health. Publishing an
 *    unverified URL would point every installed APK at a dead host.
 */

import { ApiError, OpenHandsClient, SandboxShell, WORKER_PORTS } from './openhandsClient.mjs';
import { VERDICT } from './discovery.mjs';
import { log } from './log.mjs';

const REPO_URL = process.env.WATCHDOG_REPO_URL || 'https://github.com/rasonjonathan6-coder/my-ai-studio.git';
const REPO_BRANCH = process.env.WATCHDOG_REPO_BRANCH || 'main';
const WORK_DIR = '/workspace/project';
const PORT = WORKER_PORTS.WORKER_1;

export class RecoveryError extends Error {
  constructor(message, { stage, detail } = {}) {
    super(message);
    this.name = 'RecoveryError';
    this.stage = stage;
    this.detail = detail;
  }
}

/** Builds the shell command that starts the studio, without any secret in it. */
export function startCommand({ port = PORT, logFile = '/tmp/my-ai-studio.log' } = {}) {
  // The signing key is generated in the sandbox at start time. Reading it from
  // the environment here would put it in this process and in any log that
  // echoes the command.
  //
  // The steps are chained with && rather than separated by spaces: joined by
  // spaces, `cd DIR rm -f FILE` becomes one cd with two arguments, which fails
  // and leaves the server never started. The launch itself is wrapped in a
  // subshell so the command returns immediately instead of waiting on the
  // server, and `env` passes only the named variables through so the studio does
  // not inherit this process's environment.
  return [
    `cd ${WORK_DIR}`,
    `rm -f ${logFile}`,
    `SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\\n')`,
    // The env assignments must be one argument of a single `env` invocation:
    // splitting them across array entries would put the && separators inside the
    // env command, which fails.
    [
      `(nohup env`,
      `PORT=${port}`,
      `JWT_SECRET="$SECRET"`,
      `NODE_ENV=production`,
      // This host is a single-tenant sandbox that exists only to serve the
      // studio, so running the agent's commands in-process is the intended mode.
      `ALLOW_HOST_EXECUTION_IN_PRODUCTION=true`,
      `node backend/dist/server.js > ${logFile} 2>&1 &)`,
    ].join(' '),
    `echo LAUNCHED`,
  ].join(' && ');
}

/**
 * Optional secrets to forward into the recovered runtime, but only the ones the
 * watchdog was actually given. A missing one is reported, not invented.
 */
export function forwardableSecrets() {
  const names = ['DATABASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL'];
  return names.filter((name) => {
    const value = process.env[name];
    return typeof value === 'string' && value.length > 0;
  });
}

async function step(name, fn) {
  const started = Date.now();
  log.info(`step started: ${name}`);
  try {
    const result = await fn();
    log.info(`step ok: ${name}`, { ms: Date.now() - started });
    return result;
  } catch (err) {
    log.error(`step failed: ${name}`, {
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      detail: err instanceof ApiError ? err.detail : undefined,
    });
    throw err instanceof RecoveryError
      ? err
      : new RecoveryError(`${name} failed: ${err instanceof Error ? err.message : err}`, { stage: name });
  }
}

/**
 * Runs the whole recovery. Returns the new studio URL once it has answered
 * health publicly. Throws on any failure, having cleaned up the sandbox it
 * created so a failed attempt does not leave a running runtime behind.
 */
export async function recoverStudio({
  client = new OpenHandsClient(),
  publish,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  healthProbe,
} = {}) {
  let sandbox = null;
  try {
    await step('validate credential', () => client.whoAmI());

    sandbox = await step('create sandbox', () => client.startSandbox());
    const sandboxId = sandbox.id;
    log.info('sandbox running', { sandboxId, status: sandbox.status });

    const shell = new SandboxShell({
      agentServerUrl: OpenHandsClient.agentServerUrl(sandbox),
      sessionApiKey: sandbox.session_api_key,
    });

    await step('restore repository', async () => {
      const result = await shell.runChecked(
        `cd /workspace && rm -rf project && git clone --depth 1 --branch ${REPO_BRANCH} ${REPO_URL} project 2>&1 | tail -2`,
        { timeoutMs: 300_000 },
      );
      log.info('repository restored', { output: result.stdout.trim().slice(0, 200) });
    });

    await step('install dependencies and build', async () => {
      // A single command so the build only proceeds when the install succeeded.
      const result = await shell.run(
        `cd ${WORK_DIR} && npm install --no-audit --no-fund > /tmp/install.log 2>&1 && npm run build > /tmp/build.log 2>&1; echo "EXIT=$?"`,
        { timeoutMs: 900_000 },
      );
      if (!/EXIT=0/.test(result.stdout)) {
        const tail = await shell.run('tail -30 /tmp/install.log /tmp/build.log 2>/dev/null');
        throw new RecoveryError('install or build failed', {
          stage: 'build',
          detail: tail.stdout.slice(0, 1_500),
        });
      }
    });

    await step('start studio', async () => {
      // The recovered runtime is started with no credential from this process.
      // There is no way to hand it one safely: the sandbox secrets API is
      // read-only, so the only channel would be the command string itself, which
      // is recorded in the sandbox's bash event history and readable through the
      // API afterwards. A signing key generated inside the sandbox is fine;
      // copying a real key in would leave it lying in that history.
      const unavailable = ['DATABASE_URL', 'OPENROUTER_API_KEY'].filter(
        (name) => !forwardableSecrets().includes(name),
      );
      log.warn('starting the recovered studio without provider or database configuration', {
        // Stated plainly so a recovered runtime running in-memory with no AI is
        // never mistaken for a fully configured one.
        unset: unavailable,
        note: 'configure these on the new runtime; they are deliberately not copied from here',
      });

      const result = await shell.run(startCommand(), { timeoutMs: 120_000 });
      if (result.exitCode !== 0) {
        throw new RecoveryError('start command failed', { stage: 'start', detail: result.stderr.slice(0, 800) });
      }
      await sleep(10_000);
      const logTail = await shell.run('tail -20 /tmp/my-ai-studio.log 2>/dev/null');
      log.info('studio log tail', { output: logTail.stdout.slice(0, 1_000) });
    });

    await step('confirm studio is serving locally', async () => {
      // The server needs a moment to bind the port, so this polls rather than
      // sampling once and calling a slow start a failure.
      const result = await shell.run(
        `for i in $(seq 1 15); do ` +
          `code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/api/health); ` +
          `[ "$code" = "200" ] && { echo READY; exit 0; }; sleep 2; done; echo "TIMEOUT:$code"`,
        { timeoutMs: 90_000 },
      );
      if (!result.stdout.includes('READY')) {
        const logTail = await shell.run('tail -30 /tmp/my-ai-studio.log 2>/dev/null');
        throw new RecoveryError(`local health never returned 200 (${result.stdout.trim()})`, {
          stage: 'local-health',
          detail: logTail.stdout.slice(0, 2_000),
        });
      }
    });

    const fresh = await client.getSandbox(sandboxId);
    const publicUrl = OpenHandsClient.urlForPort(fresh ?? sandbox, PORT);
    if (!publicUrl) {
      throw new RecoveryError(`sandbox exposes no URL for port ${PORT}`, { stage: 'public-url' });
    }
    log.info('public URL resolved', { publicUrl });

    // The gate that matters: the URL must answer from outside the sandbox before
    // it is published, or every installed APK follows a dead host. The probe
    // returns the same verdict shape the detection step uses, so "alive" means
    // the same thing in both places.
    await step('confirm studio is reachable publicly', async () => {
      if (!healthProbe) throw new RecoveryError('no public health probe provided', { stage: 'public-health' });
      const result = await healthProbe(publicUrl);
      const alive = result?.verdict ? result.verdict === VERDICT.ALIVE : result?.ok === true;
      if (!alive) {
        throw new RecoveryError(`public health failed: ${result?.detail ?? 'no detail'}`, {
          stage: 'public-health',
        });
      }
      log.info('public health confirmed', { detail: result.detail });
    });

    await step('publish new URL', async () => {
      if (!publish) throw new RecoveryError('no publisher provided', { stage: 'publish' });
      await publish(publicUrl);
    });

    return { publicUrl, sandboxId };
  } catch (err) {
    if (sandbox?.id) {
      // Leaving a half-built runtime running would waste the quota and confuse
      // the next run, so a failed recovery cleans up after itself.
      try {
        await client.deleteSandbox(sandbox.id);
        log.warn('discarded failed sandbox', { sandboxId: sandbox.id });
      } catch (cleanupErr) {
        log.error('could not discard failed sandbox', {
          sandboxId: sandbox.id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }
    throw err;
  }
}

export { REPO_URL, REPO_BRANCH, WORK_DIR, PORT };
