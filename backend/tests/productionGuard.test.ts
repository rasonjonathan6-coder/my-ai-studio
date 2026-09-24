/**
 * Real tests for the production host-execution guard.
 *
 * The host execution backend runs agent commands inside the server process, so
 * a command can read the server's environment file and every provider key in
 * it. Output redaction masks secrets in plain output, but it is a text filter,
 * not a boundary: `base64 .env`, `od -c .env` and `rev .env` all returned the
 * raw key during manual verification. A public deployment with the host backend
 * therefore hands every secret to any authenticated user.
 *
 * Config is read once at module load, so each case runs the real server entry
 * point in a child process with its own environment and asserts on the actual
 * start/refuse outcome. Nothing is mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BACKEND = new URL('..', import.meta.url).pathname;
const STRONG_SECRET = 'a'.repeat(48);

/**
 * `npm test` does not build first, and CI runs the suite before `npm run build`,
 * so `dist/server.js` is usually absent. The source entry is written with
 * explicit `.ts` import specifiers and runs directly under type stripping, so
 * fall back to it rather than depending on a build having happened.
 */
function resolveEntry(): { file: string; execArgv: string[] } {
  if (existsSync(path.join(BACKEND, 'dist', 'server.js'))) {
    return { file: 'dist/server.js', execArgv: [] };
  }
  return { file: 'src/server.ts', execArgv: ['--experimental-strip-types'] };
}

/**
 * Boots the compiled server and resolves once it either refuses to start or
 * logs that it is listening. A server that starts is then stopped, because a
 * listening process never exits on its own.
 */
function boot(env: Record<string, string>): Promise<{ refused: boolean; output: string }> {
  return new Promise((resolve) => {
    const entry = resolveEntry();
    const child = spawn('node', [...entry.execArgv, entry.file], {
      cwd: BACKEND,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        JWT_SECRET: STRONG_SECRET,
        SANDBOX_ENABLED: '',
        ALLOW_HOST_EXECUTION_IN_PRODUCTION: '',
        DATABASE_URL: '',
        PORT: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let done = false;
    const finish = (refused: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ refused, output });
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (/Refusing to start/.test(output)) finish(true);
      else if (/listening/i.test(output)) finish(false);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => finish(/Refusing to start/.test(output)));

    // A started server binds to an ephemeral port and never exits, so this is
    // the backstop rather than the primary signal.
    const timer = setTimeout(() => finish(/Refusing to start/.test(output)), 15_000);
  });
}

test('production refuses to start when the sandbox is disabled', async () => {
  const { refused, output } = await boot({});
  assert.equal(refused, true, `expected a refusal, got: ${output.slice(0, 400)}`);
  assert.match(output, /SANDBOX_ENABLED/);
});

test('production starts when the sandbox is enabled', async () => {
  const { refused } = await boot({ SANDBOX_ENABLED: 'true' });
  assert.equal(refused, false);
});

test('the escape hatch lets a trusted single-tenant host opt in', async () => {
  const { refused } = await boot({ ALLOW_HOST_EXECUTION_IN_PRODUCTION: 'true' });
  assert.equal(refused, false);
});

test('development is unaffected by the guard', async () => {
  const { refused } = await boot({ NODE_ENV: 'development', JWT_SECRET: '' });
  assert.equal(refused, false);
});

/**
 * The boot guard only inspects SANDBOX_ENABLED. A sandbox flag that is set but
 * not usable (image missing, daemon down) used to fall back to the host backend
 * at execution time, which silently restored the secret-reading path the guard
 * exists to close. These cases pin the fail-closed behaviour of resolveBackend.
 *
 * The unusable-sandbox cases point DOCKER_HOST at a socket that cannot exist, so
 * the real daemon probe fails and the outcome does not depend on whether Docker
 * happens to be running on the machine executing the tests.
 */
const UNREACHABLE_DOCKER = 'unix:///nonexistent/docker.sock';

function resolveWith(env: Record<string, string>): Promise<{ backend: string | null; error: string | null }> {
  const script = `const { resolveBackend } = await import('${BACKEND}src/services/commandRunner.ts');
    try { console.log(JSON.stringify({ backend: await resolveBackend('auto'), error: null })); }
    catch (err) { console.log(JSON.stringify({ backend: null, error: err.message })); }`;
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: BACKEND,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        JWT_SECRET: STRONG_SECRET,
        SANDBOX_ENABLED: 'true',
        ALLOW_HOST_EXECUTION_IN_PRODUCTION: '',
        DATABASE_URL: '',
        DOCKER_HOST: UNREACHABLE_DOCKER,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', () => {
      const line = out.split('\n').reverse().find((l) => l.startsWith('{'));
      if (!line) return reject(new Error(`no result: ${out.slice(0, 300)}`));
      resolve(JSON.parse(line));
    });
  });
}

test('production fails closed when the sandbox daemon is unreachable', async () => {
  const { backend, error } = await resolveWith({});
  assert.equal(backend, null, 'expected a refusal, got a backend');
  assert.match(error ?? '', /Refusing to run commands/);
  assert.match(error ?? '', /daemon is unreachable/i);
});

test('production fails closed when the sandbox image is missing', async () => {
  // Daemon reachable (the real one), image absent: a different refuse() branch.
  const { backend, error } = await resolveWith({
    DOCKER_HOST: '',
    SANDBOX_IMAGE: 'my-ai-studio-sandbox:does-not-exist',
  });
  // On a machine with no Docker at all this lands on the daemon branch instead;
  // either way the call must refuse rather than return a host backend.
  assert.equal(backend, null, 'expected a refusal, got a backend');
  assert.match(error ?? '', /Refusing to run commands/);
});

test('the explicit opt-in still permits host execution in production', async () => {
  const { backend, error } = await resolveWith({ ALLOW_HOST_EXECUTION_IN_PRODUCTION: 'true' });
  assert.equal(error, null);
  assert.equal(backend, 'host');
});

test('development still falls back to host when the sandbox is unusable', async () => {
  const { backend, error } = await resolveWith({ NODE_ENV: 'development' });
  assert.equal(error, null);
  assert.equal(backend, 'host');
});
