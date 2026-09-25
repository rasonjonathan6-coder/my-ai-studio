/**
 * Tests for the process-level contract of watchdog.mjs.
 *
 * Everything else in this suite calls functions and asserts on what they return.
 * These tests run the actual command line instead, because the thing that broke
 * was not a return value: it was the mapping from a result to an exit code. A
 * dead studio detected with --plan reported `would-rebuild` and then exited 0,
 * which is the code that means "healthy", so the workflow's
 *
 *   steps.detect.outputs.exit_code != '0'
 *
 * read as false and never ran the recovery. Every unit test still passed, and
 * the CI was green, while the one path that is supposed to bring a dead studio
 * back could not be reached at all.
 *
 * The real process is spawned here with a real HTTP server in front of it, over
 * loopback, so the network is genuine without depending on anything outside the
 * runner. Only the studio's answers are chosen by the test.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const WATCHDOG = fileURLToPath(new URL('../src/watchdog.mjs', import.meta.url));
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Runs a git command and returns its stdout. */
function gitOutput(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`git ${args.join(' ')}: ${stderr}`)),
    );
  });
}

/**
 * Builds a real repository with a real bare remote, so that a publish performed
 * against it commits and pushes for real. The publisher shells out to
 * `scripts/url-json-update.mjs`, so the real script is installed into the fixture
 * rather than a stand-in: the code under test is the code that ships.
 */
async function gitInitFixtureRepo(repo, { withRemote = true } = {}) {
  await gitOutput(repo, ['init', '--quiet', '--initial-branch=main']);
  await gitOutput(repo, ['config', 'user.email', 'watchdog@users.noreply.github.com']);
  await gitOutput(repo, ['config', 'user.name', 'watchdog']);
  await writeFile(
    join(repo, 'url.json'),
    `${JSON.stringify({ schema: 1, service: 'my-ai-studio', url: 'https://old.example', previousUrl: null, updatedAt: '2026-01-01T00:00:00.000Z', status: 'online' }, null, 2)}\n`,
  );

  await mkdir(join(repo, 'scripts'), { recursive: true });
  const real = fileURLToPath(new URL('../../scripts/url-json-update.mjs', import.meta.url));
  await writeFile(join(repo, 'scripts', 'url-json-update.mjs'), await readFile(real, 'utf8'));
  await gitOutput(repo, ['add', '.']);
  await gitOutput(repo, ['commit', '--quiet', '-m', 'fixture']);
  if (!withRemote) return;
  const remote = `${repo}-remote.git`;
  // Run from the repository: the bare directory does not exist yet, and git
  // creates it for the argument, but not as a working directory to spawn in.
  await gitOutput(repo, ['init', '--quiet', '--bare', remote]);
  await gitOutput(repo, ['remote', 'add', 'origin', remote]);
  await gitOutput(repo, ['push', '--quiet', 'origin', 'main']);
}

/** What the studio should answer, per test. */
const behaviour = { status: 502, body: null };

let server;
let baseUrl;
let stateDir;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/url.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          schema: 1,
          service: 'my-ai-studio',
          url: baseUrl,
          previousUrl: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
          status: 'online',
        }),
      );
      return;
    }
    const { status, body } = behaviour;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === null ? 'Bad Gateway' : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  stateDir = await mkdtemp(join(tmpdir(), 'watchdog-cli-'));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(stateDir, { recursive: true, force: true });
});

/**
 * Runs the real command and resolves with its exit code and output.
 *
 * Spawned asynchronously rather than with spawnSync: this test's HTTP server
 * lives in this process, so blocking the event loop here would stop the server
 * from answering and the child would time out instead of reaching a verdict.
 * The timeout bounds a hung child.
 */
function runWatchdog(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WATCHDOG, ...args], {
      env: {
        ...process.env,
        URL_JSON_URL: `${baseUrl}/url.json`,
        // One attempt, no backoff: the classification is covered in discovery
        // tests, so this only has to reach the verdict quickly.
        WATCHDOG_HEALTH_ATTEMPTS: '1',
        WATCHDOG_HEALTH_DELAY_MS: '0',
        WATCHDOG_STATE_PATH: join(stateDir, 'state.json'),
        // --plan never builds a client, so no credential is needed or present.
        OPENHANDS_API_KEY: '',
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`watchdog ${args.join(' ')} did not exit within 30s\n${stdout}`));
        return;
      }
      resolve({ code, stdout, stderr, output: stdout + stderr });
    });
  });
}

describe('watchdog CLI exit codes', () => {
  it('exits 2 when a dead studio is detected in plan mode', async () => {
    // This is the regression. Exit 0 here meant "healthy", so the workflow
    // skipped the very step the detection had just justified.
    behaviour.status = 502;
    behaviour.body = null;
    const { code, output } = await runWatchdog('--plan');

    assert.match(output, /studio is dead/);
    assert.match(output, /every one of 1 attempts returned HTTP 502/);
    assert.match(output, /would rebuild now, but no sandbox was created/);
    assert.equal(code, 2, `--plan on a dead studio must exit 2, got ${code}`);
  });

  it('exits 2 for a 404, which is conclusive on its own', async () => {
    behaviour.status = 404;
    behaviour.body = null;
    const { code, output } = await runWatchdog('--plan');

    assert.match(output, /studio is dead/);
    assert.equal(code, 2);
  });

  it('exits 0 when the studio is alive', async () => {
    behaviour.status = 200;
    behaviour.body = { ok: true, service: 'my-ai-studio', version: '1.0.0' };
    const { code, output } = await runWatchdog('--plan');

    assert.match(output, /studio is alive; nothing to do/);
    assert.equal(code, 0, `a healthy studio must exit 0, got ${code}`);
  });

  it('exits 0 when the answer is inconclusive', async () => {
    // A 500 means the process answered and threw. That must not read as "go
    // rebuild", or a broken endpoint would churn runtimes.
    behaviour.status = 500;
    behaviour.body = null;
    const { code, output } = await runWatchdog('--plan');

    assert.match(output, /did not answer conclusively/);
    assert.equal(code, 0, `an inconclusive answer must exit 0, got ${code}`);
  });

  it('separates "would rebuild" from "healthy" by exit code alone', async () => {
    // The workflow only reads the exit code, never the log. So the two outcomes
    // have to differ in the code, and this asserts them against each other
    // rather than against a constant written twice.
    behaviour.status = 502;
    behaviour.body = null;
    const dead = await runWatchdog('--plan');

    behaviour.status = 200;
    behaviour.body = { ok: true, service: 'my-ai-studio' };
    const alive = await runWatchdog('--plan');

    assert.notEqual(dead.code, alive.code);
    assert.equal(alive.code, 0);
    assert.equal(dead.code, 2);
  });
});

/**
 * Exit codes for the paths that only exist past detection.
 *
 * A full cycle cannot be exercised against the real service, but it can be
 * exercised against a local stand-in for the two APIs the watchdog talks to:
 * the app-server it creates a sandbox with, and the agent-server it sends shell
 * commands to. Both are real HTTP servers on loopback, so the client code under
 * test is the real client - only the answers are chosen here.
 *
 * No sandbox is created anywhere: the "sandbox" is an object in this process.
 * The one thing that is deliberately not faked is the ordering the recovery
 * enforces, because that ordering is what these codes report on.
 */
describe('watchdog CLI exit codes for a full cycle', () => {
  const SANDBOX_ID = 'sb-cli-fake';

  let api;
  let apiUrl;
  let cycleDir;
  /** Flipped once the studio has been "started", so public health can pass. */
  let studioStarted;

  async function startFakeApi() {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const json = (status, body) => {
        const payload = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json' }).end(payload);
      };

      if (url.pathname === '/url.json') {
        return json(200, {
          schema: 1,
          service: 'my-ai-studio',
          url: apiUrl,
          previousUrl: null,
          updatedAt: '2026-01-01T00:00:00.000Z',
          status: 'online',
        });
      }

      // The studio's health endpoint. Dead until the studio is started, which
      // is what makes detection conclude "dead" and recovery conclude "alive".
      if (url.pathname === '/api/health') {
        if (!studioStarted) {
          res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad Gateway');
          return;
        }
        return json(200, { ok: true, service: 'my-ai-studio', version: '1.0.0' });
      }

      if (url.pathname === '/api/v1/users/me') return json(200, { id: 'fixture-user' });

      if (url.pathname === '/api/v1/sandboxes' && req.method === 'POST') {
        return json(200, {
          id: SANDBOX_ID,
          status: 'RUNNING',
          session_api_key: 'fixture-session-key-not-a-real-value',
          exposed_urls: [
            { name: 'AGENT_SERVER', port: 60000, url: apiUrl },
            { name: 'WORKER_1', port: 12000, url: apiUrl },
          ],
        });
      }

      if (url.pathname === '/api/v1/sandboxes/search') {
        return json(200, {
          items: [
            {
              id: SANDBOX_ID,
              status: 'RUNNING',
              session_api_key: 'fixture-session-key-not-a-real-value',
              exposed_urls: [
                { name: 'AGENT_SERVER', port: 60000, url: apiUrl },
                { name: 'WORKER_1', port: 12000, url: apiUrl },
              ],
            },
          ],
        });
      }

      if (url.pathname.startsWith('/api/v1/sandboxes/') && req.method === 'DELETE') {
        return json(200, { success: true });
      }

      if (url.pathname === '/api/bash/execute_bash_command') {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => {
          let command = '';
          try {
            command = JSON.parse(raw).command ?? '';
          } catch {
            command = '';
          }
          const reply = (stdout, exitCode = 0, stderr = '') =>
            json(200, { exit_code: exitCode, stdout, stderr });

          if (command.includes('git clone')) return reply('Cloning into project...');
          if (command.includes('npm install')) {
            if (api.failBuild) return reply('EXIT=1');
            return reply('EXIT=0');
          }
          if (command.includes('LAUNCHED')) {
            studioStarted = true;
            return reply('LAUNCHED');
          }
          if (command.includes('127.0.0.1') && command.includes('/api/health')) return reply('READY\n');
          return reply('ok');
        });
        return undefined;
      }

      return json(404, { detail: 'not found' });
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
  }

  /**
   * Runs a real cycle against the fake APIs.
   *
   * `mode` chooses the argument the workflow would pass: `plan` is detection
   * only, `dry-run` rebuilds but writes nothing, and `publish` is the real
   * recovery path - no --dry-run - which commits and pushes url.json.
   */
  async function runCycleCli({
    mode = 'rebuild',
    env = {},
    seedState = null,
    extraArgs = [],
    watchdog = WATCHDOG,
  } = {}) {
    const args = mode === 'plan' ? ['--plan'] : mode === 'publish' ? [] : ['--dry-run'];
    const child = spawn(process.execPath, [watchdog, ...args, ...extraArgs], {
      env: {
        ...process.env,
        URL_JSON_URL: `${apiUrl}/url.json`,
        OPENHANDS_BASE_URL: apiUrl,
        OPENHANDS_API_KEY: 'fixture-openhands-key-not-a-real-value',
        WATCHDOG_HEALTH_ATTEMPTS: '1',
        WATCHDOG_HEALTH_DELAY_MS: '0',
        WATCHDOG_MIN_REBUILD_GAP_MS: '0',
        WATCHDOG_STATE_PATH: join(cycleDir, 'state.json'),
        MY_AI_STUDIO_DOMAIN: '',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const code = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', done);
    });
    clearTimeout(timer);
    return { code, stdout, stderr, output: `${stdout}${stderr}` };
  }

  before(async () => {
    const started = await startFakeApi();
    api = started;
    apiUrl = started.url;
    cycleDir = await mkdtemp(join(tmpdir(), 'watchdog-cycle-cli-'));
  });

  after(async () => {
    await new Promise((done) => api.server.close(done));
    await rm(cycleDir, { recursive: true, force: true });
  });

  it('exits 2 for a rebuild that completed', async () => {
    // The whole point of the plan-mode fix: a completed rebuild must not report
    // the code that means healthy. The cycle is real - detection, sandbox
    // creation, clone, install, start, both health checks - with the APIs
    // answered locally and url.json left alone by --dry-run.
    studioStarted = false;
    const { code, output } = await runCycleCli({ mode: 'rebuild' });

    assert.match(output, /studio is dead/);
    assert.match(output, /sandbox created/);
    assert.match(output, /public health confirmed/);
    assert.match(output, /dry-run: would publish url\.json/);
    assert.match(output, /cycle finished/);
    assert.equal(code, 2, `a completed rebuild must exit 2, got ${code}`);
  });

  it('never reports a rebuild with exit 0', async () => {
    // Stated on its own because it is the invariant the workflow depends on:
    // exit 0 must mean "nothing needed doing", never "something was done".
    studioStarted = false;
    const { code } = await runCycleCli({ mode: 'rebuild' });
    assert.notEqual(code, 0);
  });

  it('exits 1 when the rebuild budget is exhausted', async () => {
    studioStarted = false;
    const statePath = join(cycleDir, 'state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({
        rebuilds: [{ at: new Date().toISOString(), url: 'https://earlier.example', sandboxId: 'sb-earlier' }],
      })}\n`,
      'utf8',
    );
    const { code, output } = await runCycleCli({
      mode: 'rebuild',
      env: { WATCHDOG_MAX_REBUILDS_PER_DAY: '1' },
    });
    await rm(statePath, { force: true });

    assert.match(output, /refusing to rebuild/);
    assert.match(output, /budget exhausted/);
    assert.equal(code, 1, `a blocked cycle must exit 1, got ${code}`);
  });

  it('exits 1 when the recovery fails, and publishes nothing', async () => {
    studioStarted = false;
    api.failBuild = true;
    try {
      const { code, output } = await runCycleCli({ mode: 'rebuild' });

      assert.match(output, /install or build failed/);
      assert.match(output, /discarded failed sandbox/);
      assert.doesNotMatch(output, /would publish url\.json/);
      assert.doesNotMatch(output, /cycle finished/);
      assert.equal(code, 1, `a failed recovery must exit 1, got ${code}`);
    } finally {
      api.failBuild = false;
    }
  });

  it('publishes url.json for real when run without --dry-run', async () => {
    // The path the workflow takes. Everything before this point is tested in
    // dry-run, which cannot show whether the commit or the push works at all:
    // dry-run returns before either is reached. This runs the real thing against
    // a real repository and checks what git actually recorded.
    const repo = await mkdtemp(join(tmpdir(), 'watchdog-publish-'));
    try {
      await gitInitFixtureRepo(repo);
      studioStarted = false;

      const { code, output } = await runCycleCli({
        mode: 'publish',
        extraArgs: ['--repo-root', repo],
      });

      assert.match(output, /studio is dead/);
      assert.match(output, /public health confirmed/);
      assert.match(output, /committed the published url/);
      assert.match(output, /pushed the published url/);
      assert.doesNotMatch(output, /dry-run/);
      assert.equal(code, 2, `a completed rebuild must exit 2, got ${code}`);

      // url.json really changed, and only url.json.
      const written = JSON.parse(await readFile(join(repo, 'url.json'), 'utf8'));
      assert.equal(written.url, apiUrl);
      const changed = await gitOutput(repo, ['show', '--name-only', '--format=', 'HEAD']);
      assert.deepEqual(changed.trim().split('\n').filter(Boolean), ['url.json']);

      // And the commit reached the remote, which is what "published" means for
      // an installed APK reading raw.githubusercontent.com.
      const remote = await gitOutput(`${repo}-remote.git`, ['log', '--format=%s', 'main']);
      assert.match(remote, /chore\(watchdog\): publish studio url /);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(`${repo}-remote.git`, { recursive: true, force: true });
    }
  });

  it('fails the run when the push cannot land, and discards the sandbox', async () => {
    // A publish that cannot reach the remote is a failed publish. The exit code
    // has to say so, because the job's only other signal is that code.
    const repo = await mkdtemp(join(tmpdir(), 'watchdog-nopush-'));
    try {
      await gitInitFixtureRepo(repo, { withRemote: false });
      studioStarted = false;

      const { code, output } = await runCycleCli({
        mode: 'publish',
        extraArgs: ['--repo-root', repo],
      });

      assert.match(output, /git push to main failed/);
      assert.match(output, /discarded failed sandbox/);
      assert.doesNotMatch(output, /cycle finished/);
      assert.notEqual(code, 0, 'a failed push must not exit 0');
      assert.equal(code, 1, `a failed publish must exit 1, got ${code}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * The repository root the publisher computes for itself.
   *
   * The recovery once rebuilt a studio successfully and then failed at the publish
   * step with `Cannot find module .../watchdog/scripts/url-json-update.mjs`:
   * watchdog.mjs sits in watchdog/src/, so `new URL('..', import.meta.url)` climbed
   * to watchdog/, not to the repository root. Nothing caught it because every test
   * passed `--repo-root` explicitly, leaving the default path - the one the workflow
   * actually uses - unexercised. These tests exercise that default for real: the
   * watchdog is run from a copy of the tree, without --repo-root, and the publish
   * step has to locate the real script from its own location alone.
   */
  describe('watchdog: the default repository root', () => {
    it('resolves to the repository root, where the publish script lives', async () => {
      const { defaultRepoRoot } = await import('../src/watchdog.mjs');
      const root = defaultRepoRoot();

      assert.equal(
        root,
        REPO_ROOT,
        'the default root no longer points at the repository root; the publisher will not find scripts/url-json-update.mjs',
      );
      assert.ok(
        existsSync(join(root, 'scripts', 'url-json-update.mjs')),
        'the publish script is not at <root>/scripts/url-json-update.mjs',
      );
    });

    it('publishes from the default root when --repo-root is not passed', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'watchdog-default-root-'));
      try {
        // A real copy of the watchdog's own sources. Only src/ and package.json
        // are copied: the checkout carries a nested .git for the watchdog dir,
        // and copying it would put a second repository inside the fixture. The
        // watchdog imports nothing outside node built-ins, so src/ is the whole
        // dependency surface.
        await mkdir(join(repo, 'watchdog'), { recursive: true });
        await cp(join(REPO_ROOT, 'watchdog', 'src'), join(repo, 'watchdog', 'src'), {
          recursive: true,
        });
        await cp(
          join(REPO_ROOT, 'watchdog', 'package.json'),
          join(repo, 'watchdog', 'package.json'),
        );
        await mkdir(join(repo, 'scripts'), { recursive: true });
        await cp(
          join(REPO_ROOT, 'scripts', 'url-json-update.mjs'),
          join(repo, 'scripts', 'url-json-update.mjs'),
        );
        await writeFile(
          join(repo, 'url.json'),
          `${JSON.stringify({ schema: 1, service: 'my-ai-studio', url: 'https://old.example', previousUrl: null, updatedAt: '2026-01-01T00:00:00.000Z', status: 'online' }, null, 2)}\n`,
        );
        await gitOutput(repo, ['init', '--quiet', '--initial-branch=main']);
        await gitOutput(repo, ['config', 'user.email', 'watchdog@users.noreply.github.com']);
        await gitOutput(repo, ['config', 'user.name', 'watchdog']);
        await gitOutput(repo, ['add', '.']);
        await gitOutput(repo, ['commit', '--quiet', '-m', 'fixture']);

        const remote = `${repo}-remote.git`;
        await gitOutput(repo, ['init', '--quiet', '--bare', remote]);
        await gitOutput(repo, ['remote', 'add', 'origin', remote]);
        await gitOutput(repo, ['push', '--quiet', 'origin', 'main']);

        studioStarted = false;
        // No --repo-root: the point is the default. Before the fix this reached
        // url-json-update.mjs under the wrong parent and exited 1 without ever
        // writing url.json.
        const { code, output } = await runCycleCli({
          mode: 'publish',
          watchdog: join(repo, 'watchdog', 'src', 'watchdog.mjs'),
        });

        assert.doesNotMatch(output, /Cannot find module/);
        assert.match(output, /committed the published url/);
        assert.match(output, /pushed the published url/);
        assert.equal(code, 2, `a completed rebuild must exit 2, got ${code}`);

        const written = JSON.parse(await readFile(join(repo, 'url.json'), 'utf8'));
        assert.equal(written.url, apiUrl, 'url.json was not updated through the default root');

        const changed = await gitOutput(repo, ['show', '--name-only', '--format=', 'HEAD']);
        assert.deepEqual(changed.trim().split('\n').filter(Boolean), ['url.json']);

        const pushed = await gitOutput(remote, ['log', '--format=%s', 'main']);
        assert.match(pushed, /chore\(watchdog\): publish studio url /);
      } finally {
        await rm(repo, { recursive: true, force: true });
        await rm(`${repo}-remote.git`, { recursive: true, force: true });
      }
    });
  });
});
