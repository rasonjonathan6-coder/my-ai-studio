/**
 * Recovering My AI Studio into a fresh OpenHands sandbox.
 *
 * Every step here was run by hand against the live API before being written
 * down, so the commands are known to work rather than assumed to:
 * clone, install, build, start on the exposed port, and answer /api/health from
 * the public URL. That last check is the point of the whole file: a sandbox that
 * runs the server but cannot be reached is not a recovery.
 *
 *  - The recovered runtime is given the configuration it needs to actually work - the
 *    database, the provider key, the signing key - but the values never travel through
 *    a command. They are written to an environment file over multipart, restricted to
 *    its owner, and read back at launch with `node --env-file`. A value placed in a
 *    command would be recorded in the sandbox's bash event history and stay readable
 *    through the API after the run; a value placed in the environment file does not.
 *    Nothing is invented: a name the watchdog was not given is reported as missing
 *    rather than filled with a generated stand-in.
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

/** Where the recovered runtime's environment file is written, inside the sandbox. */
export const ENV_FILE = '/tmp/studio.env';

/**
 * Every name the recovered runtime can be given, and whether it is a secret.
 *
 * The secrets are listed separately from the plain configuration because only the
 * secrets are subject to the redaction list and to the rule that they may never
 * appear in a command. `DATABASE_SSL`, `OPENROUTER_MODEL` and
 * `MY_AI_STUDIO_ADMIN_EMAIL` are ordinary configuration: an operator debugging a
 * recovery needs to see them in a log, so masking them would cost more than it buys.
 */
export const FORWARDABLE = [
  { name: 'DATABASE_URL', secret: true },
  { name: 'DATABASE_SSL', secret: false },
  { name: 'OPENROUTER_API_KEY', secret: true },
  { name: 'OPENROUTER_MODEL', secret: false },
  { name: 'JWT_SECRET', secret: true },
  { name: 'MY_AI_STUDIO_CREDENTIAL_KEY', secret: true },
  { name: 'MY_AI_STUDIO_ADMIN_EMAIL', secret: false },
];

/**
 * Names to forward into the recovered runtime, but only the ones the watchdog was
 * actually given. A missing one is reported, not invented, and nothing is generated
 * to stand in for it: a runtime started with a made-up credential would fail later in
 * a way that looks like a different problem.
 */
export function forwardableSecrets({ env = process.env } = {}) {
  return FORWARDABLE.map((entry) => entry.name).filter((name) => {
    const value = env[name];
    return typeof value === 'string' && value.length > 0;
  });
}

/** Names that are forwarded and look like a credential. */
export function secretNames() {
  return FORWARDABLE.filter((entry) => entry.secret).map((entry) => entry.name);
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Builds the body of the runtime's environment file. The values stay in this process
 * and in the returned string; they are never interpolated into a command.
 *
 * A value carrying a newline or a control character is refused rather than written,
 * because it would silently become two lines and change which variables the runtime
 * sees. None of the supported names holds one; a multi-line key (a PEM, say) would.
 */
export function studioEnv({ env = process.env } = {}) {
  const present = forwardableSecrets({ env });
  const lines = [];
  const refused = [];
  for (const name of present) {
    const value = String(env[name]);
    if (!ENV_NAME.test(name) || /[\n\r\u0000]/.test(value)) {
      refused.push(name);
      continue;
    }
    lines.push(`${name}=${value}`);
  }
  const missing = FORWARDABLE.map((entry) => entry.name).filter((name) => !present.includes(name));
  return {
    body: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    names: lines.map((line) => line.slice(0, line.indexOf('='))),
    missing,
    refused,
  };
}

/** The command that restricts the file to its owner. It names the path, never a value. */
export function chmodCommand({ path = ENV_FILE } = {}) {
  return `chmod 600 ${path}`;
}

/**
 * Builds the shell command that starts the studio.
 *
 * With `useEnvFile`, the configuration arrives in the environment file and the command
 * carries only its path: no value is ever interpolated here. The `env` prefix then
 * holds only non-secret settings, because an assignment there would override the file.
 *
 * Without it, the older behaviour is kept: a signing key generated inside the sandbox,
 * and nothing forwarded. That is what runs when no configuration is available, and it
 * must not be mistaken for a configured runtime - the caller logs the difference.
 */
export function startCommand({ port = PORT, logFile = '/tmp/my-ai-studio.log', useEnvFile = false, envFile = ENV_FILE } = {}) {
  // The steps are chained with && rather than separated by spaces: joined by
  // spaces, `cd DIR rm -f FILE` becomes one cd with two arguments, which fails
  // and leaves the server never started. The launch itself is wrapped in a
  // subshell so the command returns immediately instead of waiting on the
  // server.
  const settings = [`PORT=${port}`, `NODE_ENV=production`];
  if (useEnvFile) {
    // NODE_OPTIONS rather than a positional flag, so a node whose CLI rejects
    // --env-file still starts: the option is ignored instead of killing the launch.
    settings.push(`NODE_OPTIONS="--env-file=${envFile}"`);
  } else {
    settings.push(
      `JWT_SECRET="$SECRET"`,
      // This host is a single-tenant sandbox that exists only to serve the
      // studio, so running the agent's commands in-process is the intended mode.
      `ALLOW_HOST_EXECUTION_IN_PRODUCTION=true`,
    );
  }
  return [
    `cd ${WORK_DIR}`,
    `rm -f ${logFile}`,
    useEnvFile ? ': skip signing key, it comes from the environment file' : `SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\\n')`,
    `(nohup env ${settings.join(' ')} node backend/dist/server.js > ${logFile} 2>&1 &)`,
    `echo LAUNCHED`,
  ].join(' && ');
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
  env = process.env,
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

    // Built before the upload so the same reading drives both what is written and what
    // is reported as missing. Nothing here invents a value: an absent name is named,
    // not filled in.
    const config = studioEnv({ env });

    const provisioned = await step('provision runtime environment', async () => {
      if (config.names.length === 0) {
        log.warn('no runtime configuration available; the recovered studio starts unconfigured', {
          missing: config.missing,
          note: 'set the repository secrets to have a recovered runtime run with its database and provider',
        });
        return false;
      }
      if (config.refused.length > 0) {
        // Refused rather than written: a value with a newline would split into two lines
        // and change which variables the runtime ends up seeing.
        log.warn('refused a configuration value carrying a newline or a control character', {
          names: config.refused,
        });
      }
      // The content travels as the body of a multipart request. It is never placed in a
      // command: a command is recorded in the sandbox's bash event history and stays
      // readable through the API after the run.
      await shell.uploadFile(ENV_FILE, config.body);
      // Restricted before anything can read it, and before the server is started.
      await shell.runChecked(chmodCommand());
      log.info('runtime environment provisioned', {
        names: config.names,
        missing: config.missing,
        path: ENV_FILE,
      });
      return true;
    });

    await step('start studio', async () => {
      // With a configuration provisioned, the launch reads the environment file and no
      // secret is interpolated into the command. Without one, the older behaviour is
      // kept: a signing key generated inside the sandbox and no provider or database.
      const result = await shell.run(startCommand({ useEnvFile: provisioned }), { timeoutMs: 120_000 });
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
