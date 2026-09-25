/**
 * Tests that the rebuild budget survives between runs.
 *
 * Without this, the daily cap and the minimum gap are decorative: the state
 * lives in the runner's temp directory, which is created fresh for each run, so
 * every run would read an empty budget and a studio that cannot start would be
 * rebuilt on every scheduled run until the OpenHands quota was gone.
 *
 * The budget is carried as a workflow artifact, which means two things have to
 * hold, and they are tested separately because they fail in different ways:
 *
 *  - the transport: what is uploaded is one file, and what comes back is that
 *    file byte for byte at the root of the archive. This is asserted by building
 *    a real zip with the same archiver family the runner uses and reading it
 *    back.
 *  - the semantics: a state written by one run must make the next run refuse a
 *    rebuild. This is asserted with the real reading code, and the final test
 *    runs the real entry point twice as two separate processes so that "the
 *    next run" means a different process with no shared memory.
 *
 * No sandbox is created anywhere. The one test that performs a cycle does so
 * against a local stand-in for the OpenHands API, so the code under test is the
 * real code and only the answers are chosen here.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';

import { withoutForwardableNames } from './helpers.mjs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { evaluateBudget, readState } from '../src/state.mjs';
import { runCycle } from '../src/watchdog.mjs';
import { VERDICT } from '../src/discovery.mjs';

const WATCHDOG = fileURLToPath(new URL('../src/watchdog.mjs', import.meta.url));

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** The budget settings the workflow relies on. */
const BUDGET = { maxRebuildsPerDay: 4, minRebuildGapMs: 10 * MINUTE };

function settingsWith(statePath, overrides = {}) {
  return {
    documentUrl: 'https://example.invalid/url.json',
    healthAttempts: 1,
    healthDelayMs: 0,
    healthTimeoutMs: 1_000,
    documentTimeoutMs: 1_000,
    statePath,
    ...BUDGET,
    ...overrides,
  };
}

const tempDirs = [];
async function freshDir(prefix = 'budget-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A rebuild record as state.mjs writes it. */
function rebuild({ atMs, url = 'https://studio.example', sandboxId = 'sb-previous' }) {
  return { at: new Date(atMs).toISOString(), url, sandboxId };
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// The Python interpreter is used only for the archive, the same job the runner
// does with `unzip`. It is present on the runner; the guard keeps the suite
// honest rather than silently passing if it is not.
// ---------------------------------------------------------------------------
let python = null;

function runPython(args) {
  return new Promise((done, fail) => {
    const child = spawn(python, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

/** Writes `filePath` into `zipPath` with its basename at the archive root. */
async function zipSingleFile(filePath, zipPath) {
  const script = [
    'import sys, zipfile, os',
    'src, out = sys.argv[1], sys.argv[2]',
    "with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:",
    '    z.write(src, arcname=os.path.basename(src))',
  ].join('\n');
  const { code, stderr } = await runPython(['-c', script, filePath, zipPath]);
  assert.equal(code, 0, `zip failed: ${stderr}`);
}

/** Extracts `zipPath` into `destDir` and returns the member names. */
async function unzipTo(zipPath, destDir) {
  const script = [
    'import sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'z.extractall(sys.argv[2])',
    "print('\\n'.join(z.namelist()))",
  ].join('\n');
  const { code, stdout, stderr } = await runPython(['-c', script, zipPath, destDir]);
  assert.equal(code, 0, `unzip failed: ${stderr}`);
  return stdout.trim().split('\n').filter(Boolean);
}

describe('the budget archive handoff', () => {
  /** Probes a candidate without going through runPython, which needs its result. */
  function probePython(candidate) {
    return new Promise((done) => {
      let child;
      try {
        child = spawn(candidate, ['--version']);
      } catch {
        return done(false);
      }
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
      return undefined;
    });
  }

  before(async () => {
    for (const candidate of [process.env.PYTHON, 'python3', 'python']) {
      if (candidate && (await probePython(candidate))) {
        python = candidate;
        return;
      }
    }
    assert.fail('no python interpreter available to exercise the archive handoff');
  });

  it('stores the uploaded file at the root of the archive', async () => {
    // The workflow uploads a single file with `path: <file>`. If the archiver
    // preserved the directory path instead, the restore step's
    // `$RUNNER_TEMP/state/watchdog-state.json` lookup would miss and every run
    // would silently start from an empty budget.
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    await writeFile(statePath, `${JSON.stringify({ rebuilds: [rebuild({ atMs: Date.now() })] })}\n`);

    const zipPath = join(dir, 'state.zip');
    await zipSingleFile(statePath, zipPath);

    assert.ok(existsSync(zipPath));
    const names = await unzipTo(zipPath, join(dir, 'out'));
    assert.deepEqual(names, ['watchdog-state.json']);
  });

  it('returns the state file unchanged through the archive', async () => {
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    const original = `${JSON.stringify({ rebuilds: [rebuild({ atMs: Date.now(), sandboxId: 'sb-round-trip' })] }, null, 2)}\n`;
    await writeFile(statePath, original);

    const zipPath = join(dir, 'state.zip');
    await zipSingleFile(statePath, zipPath);
    await unzipTo(zipPath, join(dir, 'out'));

    const restored = await readFile(join(dir, 'out', basename(statePath)), 'utf8');
    assert.equal(restored, original, 'the budget did not survive the archive');
  });
});

describe('reading the budget on a later run', () => {
  it('starts empty when no state has ever been saved', async () => {
    // The first run of a fresh repository. This must be ordinary, not an error.
    const dir = await freshDir();
    const state = await readState(join(dir, 'never-written.json'));
    assert.deepEqual(state, { rebuilds: [] });
    assert.equal(evaluateBudget(state, BUDGET).allowed, true);
  });

  it('sees a rebuild recorded by an earlier run', async () => {
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({ rebuilds: [rebuild({ atMs: Date.now() - 30 * MINUTE })] }, null, 2)}\n`,
    );

    const state = await readState(statePath);
    assert.equal(state.rebuilds.length, 1);
    // The address is public by design; it is what url.json publishes.
    assert.equal(state.rebuilds[0].url, 'https://studio.example');
    assert.equal(state.rebuilds[0].sandboxId, 'sb-previous');
  });

  it('treats a corrupt file as empty and warns instead of failing', async () => {
    // A half-written or truncated state must not stop the watchdog from
    // checking the studio; it must only lose the budget, loudly.
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    await writeFile(statePath, '{ this is not json');

    const state = await readState(statePath);
    assert.deepEqual(state, { rebuilds: [] });
  });
});

describe('the budget decides whether a cycle may rebuild', () => {
  const readDocument = async () => ({
    url: 'https://studio.example',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'online',
  });

  /** A client that records calls; a rebuild decision must make none. */
  function recordingClient() {
    const calls = [];
    return {
      calls,
      async whoAmI() {
        calls.push('whoAmI');
        throw new Error('recovery was attempted but should not have been');
      },
    };
  }

  const dead = async () => ({ verdict: VERDICT.DEAD, detail: 'HTTP 404' });

  it('is blocked once four rebuilds fall inside the day', async () => {
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({
        rebuilds: [1, 2, 3, 4].map((n) => rebuild({ atMs: Date.now() - n * MINUTE, sandboxId: `sb-${n}` })),
      })}\n`,
    );

    const client = recordingClient();
    const result = await runCycle({
      settings: settingsWith(statePath),
      readDocument,
      client,
      healthProbe: dead,
    });

    assert.equal(result.action, 'blocked');
    assert.match(result.reason, /budget exhausted/);
    // The point of the cap: no sandbox was spent.
    assert.deepEqual(client.calls, []);
  });

  it('is blocked inside the minimum gap since the last rebuild', async () => {
    // A run that fails immediately must not be retried in a tight loop, so a
    // recent rebuild blocks the next attempt even with the day's budget left.
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    await writeFile(statePath, `${JSON.stringify({ rebuilds: [rebuild({ atMs: Date.now() - 5 * MINUTE })] })}\n`);

    const client = recordingClient();
    const result = await runCycle({
      settings: settingsWith(statePath),
      readDocument,
      client,
      healthProbe: dead,
    });

    assert.equal(result.action, 'blocked');
    assert.match(result.reason, /last rebuild was/);
    assert.deepEqual(client.calls, []);
  });

  it('opens the gate again once the last rebuild is old enough', async () => {
    // The complement of the two tests above, and the reason they are not just
    // asserting "blocked": a budget that blocks forever would be as wrong as
    // one that never blocks.
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({ rebuilds: [rebuild({ atMs: Date.now() - (DAY + MINUTE) })] })}\n`,
    );

    const state = await readState(statePath);
    assert.equal(evaluateBudget(state, BUDGET).allowed, true, 'an old rebuild still blocks');

    // Confirmed through the real cycle rather than the gate alone: the client
    // throws, so a rejection proves the cycle got past the budget and actually
    // reached the recovery. A blocked cycle would have returned instead.
    const client = recordingClient();
    await assert.rejects(
      () =>
        runCycle({ settings: settingsWith(statePath), readDocument, client, healthProbe: dead }),
      /recovery was attempted/,
    );
    assert.deepEqual(client.calls, ['whoAmI']);
  });

  it('keeps only the most recent rebuilds in the window', async () => {
    const dir = await freshDir();
    const statePath = join(dir, 'watchdog-state.json');
    await writeFile(
      statePath,
      `${JSON.stringify({
        rebuilds: [
          rebuild({ atMs: Date.now() - 3 * DAY, sandboxId: 'ancient-1' }),
          rebuild({ atMs: Date.now() - 2 * DAY, sandboxId: 'ancient-2' }),
          rebuild({ atMs: Date.now() - MINUTE, sandboxId: 'recent' }),
        ],
      })}\n`,
    );

    const state = await readState(statePath);
    const budget = evaluateBudget(state, BUDGET);
    // Two of the three are outside the 24h window, so the day's cap is unmet
    // and the gap is what blocks; the count proves the window is applied.
    assert.equal(budget.recent.length, 1);
    assert.equal(budget.allowed, false);
    assert.match(budget.reason, /last rebuild was/);
  });
});

// ---------------------------------------------------------------------------
// The claim this file exists for: state written by one run reaches the next.
// ---------------------------------------------------------------------------
describe('two consecutive runs share one budget', () => {
  let api;
  let apiUrl;
  let runDir;

  async function startFakeApi() {
    const sandboxesCreated = [];
    // Contents the watchdog uploaded, so a test can show the configuration travelled
    // as a request body rather than inside a command.
    const uploads = [];
    // The recovery verifies the sandbox URL from outside, and the working
    // sandbox serves the same address, so this request must succeed once a
    // sandbox exists. Detection, which runs first, must see it as dead.
    let studioHealthy = false;
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
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
      if (url.pathname === '/api/health') {
        if (!studioHealthy) {
          res.writeHead(502, { 'content-type': 'text/plain' }).end('Bad Gateway');
          return;
        }
        return json(200, { ok: true, service: 'my-ai-studio', version: '1.0.0' });
      }
      if (url.pathname === '/api/v1/users/me') return json(200, { id: 'fixture-user' });
      const sandboxInfo = (id) => ({
        id,
        status: 'RUNNING',
        session_api_key: 'fixture-session-key-not-a-real-value',
        exposed_urls: [
          { name: 'AGENT_SERVER', port: 60000, url: apiUrl },
          { name: 'WORKER_1', port: 12000, url: apiUrl },
        ],
      });

      if (url.pathname === '/api/v1/sandboxes' && req.method === 'POST') {
        const id = `sb-run-${sandboxesCreated.length + 1}`;
        sandboxesCreated.push(id);
        studioHealthy = true;
        return json(200, {
          id,
          status: 'RUNNING',
          session_api_key: 'fixture-session-key-not-a-real-value',
          exposed_urls: [
            { name: 'AGENT_SERVER', port: 60000, url: apiUrl },
            { name: 'WORKER_1', port: 12000, url: apiUrl },
          ],
        });
      }
      // getSandbox reads one sandbox through the id endpoint. Search paginates,
      // so answering only there let a sandbox look absent once an account held
      // more than a page of them. Both routes are kept so the harness still
      // matches the API surface.
      if (url.pathname === '/api/v1/sandboxes' && req.method === 'GET') {
        const wanted = url.searchParams.get('id');
        return json(200, sandboxesCreated.includes(wanted) ? [sandboxInfo(wanted)] : [null]);
      }

      if (url.pathname === '/api/v1/sandboxes/search') {
        return json(200, { items: sandboxesCreated.map((id) => sandboxInfo(id)) });
      }
      if (url.pathname.startsWith('/api/v1/sandboxes/') && req.method === 'DELETE') {
        return json(200, { success: true });
      }
      if (url.pathname === '/api/file/upload') {
        // The runtime configuration arrives as a multipart body, never as a command.
        // Served here so the harness matches the real API surface; the body is kept
        // only so a test can prove the content travelled this way.
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          uploads.push({ path: url.searchParams.get('path'), body: raw });
          json(200, { ok: true });
        });
        return undefined;
      }
      if (url.pathname === '/api/bash/execute_bash_command') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          let command = '';
          try {
            command = JSON.parse(raw).command ?? '';
          } catch {
            command = '';
          }
          const reply = (stdout, exitCode = 0) => json(200, { exit_code: exitCode, stdout, stderr: '' });
          if (command.includes('git clone')) return reply('Cloning...');
          if (command.includes('npm install')) return reply('EXIT=0');
          if (command.includes('LAUNCHED')) return reply('LAUNCHED');
          if (command.includes('127.0.0.1') && command.includes('/api/health')) return reply('READY\n');
          return reply('ok');
        });
        return undefined;
      }
      return json(404, { detail: 'not found' });
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return {
      server,
      url: `http://127.0.0.1:${server.address().port}`,
      sandboxesCreated,
      setStudioHealthy: (value) => {
        studioHealthy = value;
      },
    };
  }

  /** One run of the real entry point, as a separate process. */
  function runOnce(statePath, extraEnv = {}) {
    const child = spawn(process.execPath, [WATCHDOG, '--dry-run'], {
      env: {
        // Names the watchdog could forward are cleared, so the run under test sees the
        // same environment on a developer's machine as in CI. Without this, a
        // developer's own configuration would be provisioned into the fake sandbox and
        // change what these tests exercise.
        ...withoutForwardableNames(process.env),
        URL_JSON_URL: `${apiUrl}/url.json`,
        OPENHANDS_BASE_URL: apiUrl,
        OPENHANDS_API_KEY: 'fixture-openhands-key-not-a-real-value',
        WATCHDOG_HEALTH_ATTEMPTS: '1',
        WATCHDOG_HEALTH_DELAY_MS: '0',
        WATCHDOG_MIN_REBUILD_GAP_MS: String(BUDGET.minRebuildGapMs),
        WATCHDOG_MAX_REBUILDS_PER_DAY: String(BUDGET.maxRebuildsPerDay),
        WATCHDOG_STATE_PATH: statePath,
        MY_AI_STUDIO_DOMAIN: '',
        ...extraEnv,
      },
    });
    let output = '';
    const capture = (chunk) => {
      output += chunk;
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    return new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code, output });
      });
    });
  }

  before(async () => {
    const started = await startFakeApi();
    api = started;
    apiUrl = started.url;
    runDir = await freshDir('two-runs-');
  });

  after(async () => {
    await new Promise((done) => api.server.close(done));
  });

  it('carries the budget from the first run to the second', async () => {
    // Run A writes its budget into its own temp directory. The artifact handoff
    // is modelled by archiving that file and extracting it into a different
    // directory, which is what the runner does: run B's temp directory is fresh
    // and the state can only arrive through the artifact.
    const runAStatePath = join(runDir, 'run-a', 'watchdog-state.json');
    await mkdir(join(runDir, 'run-a'), { recursive: true });
    api.setStudioHealthy(false);

    const runA = await runOnce(runAStatePath);
    assert.match(runA.output, /studio is dead/);
    assert.match(runA.output, /sandbox created/);
    assert.match(runA.output, /cycle finished/);
    assert.equal(runA.code, 2, `run A should have rebuilt (exit 2), got ${runA.code}`);
    assert.equal(api.sandboxesCreated.length, 1, 'run A should have created exactly one sandbox');

    // What run A left behind, which is what gets uploaded.
    assert.ok(existsSync(runAStatePath), 'run A saved no budget');
    const savedState = JSON.parse(await readFile(runAStatePath, 'utf8'));
    assert.equal(savedState.rebuilds.length, 1);
    assert.equal(savedState.rebuilds[0].sandboxId, 'sb-run-1');

    // The handoff: archive, then restore into run B's fresh directory.
    const zipPath = join(runDir, 'artifact.zip');
    await zipSingleFile(runAStatePath, zipPath);
    const runBDir = join(runDir, 'run-b');
    await mkdir(runBDir, { recursive: true });
    await unzipTo(zipPath, runBDir);
    const runBStatePath = join(runBDir, 'watchdog-state.json');
    assert.ok(existsSync(runBStatePath), 'run B received no budget');

    // Run B sees the same dead studio, and must refuse on the strength of the
    // restored budget alone.
    api.setStudioHealthy(false);
    const runB = await runOnce(runBStatePath);
    assert.match(runB.output, /refusing to rebuild/);
    assert.match(runB.output, /last rebuild was/);
    assert.equal(runB.code, 1, `run B should have been blocked (exit 1), got ${runB.code}`);
    assert.doesNotMatch(runB.output, /sandbox created/);
    assert.doesNotMatch(runB.output, /cycle finished/);
    // The proof that the budget saved quota: still one sandbox, not two.
    assert.equal(api.sandboxesCreated.length, 1, 'run B created a sandbox despite the budget');

    // And run B's own budget still carries run A's record forward.
    const carriedState = JSON.parse(await readFile(runBStatePath, 'utf8'));
    assert.equal(carriedState.rebuilds.length, 1, 'run B did not preserve the restored budget');
    assert.equal(carriedState.rebuilds[0].sandboxId, 'sb-run-1');
  });

  it('writes no credential into the budget that gets archived', async () => {
    // The state file is uploaded as an artifact and read by later runs, so a
    // secret in it would travel further than a log line does. recordRebuild
    // keeps only the outcome, and this pins that against the real run.
    const statePath = join(runDir, 'secret-check', 'watchdog-state.json');
    await mkdir(join(runDir, 'secret-check'), { recursive: true });
    api.setStudioHealthy(false);

    const fixtures = {
      OPENHANDS_API_KEY: `sk-${'openhands'.repeat(3)}`,
      OPENROUTER_API_KEY: `sk-or-v1-${'fixture'.repeat(4)}`,
      DATABASE_URL: ['postgres://', 'fixtureuser', ':', 'fixturepassword', '@127.0.0.1:5432/db'].join(''),
      JWT_SECRET: `jwt-${'fixture'.repeat(3)}`,
      GITHUB_TOKEN: `ghp_${'G'.repeat(30)}`,
    };

    // A fresh state path so the budget is not already exhausted from run A.
    const run = await runOnce(statePath, { ...fixtures, WATCHDOG_MIN_REBUILD_GAP_MS: '0' });
    assert.ok(existsSync(statePath), 'the run saved no budget to inspect');

    const raw = await readFile(statePath, 'utf8');
    for (const [name, value] of Object.entries(fixtures)) {
      // The password half is what must never appear; a scheme alone is not a secret.
      const sensitive = name === 'DATABASE_URL' ? 'fixturepassword' : value;
      assert.ok(!raw.includes(sensitive), `${name} reached the budget artifact`);
    }
    // The file still holds what it is for.
    const parsed = JSON.parse(raw);
    assert.ok(Array.isArray(parsed.rebuilds));
    assert.ok(parsed.rebuilds.length >= 1);
  });
});
