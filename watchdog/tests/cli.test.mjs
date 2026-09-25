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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const WATCHDOG = fileURLToPath(new URL('../src/watchdog.mjs', import.meta.url));

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
