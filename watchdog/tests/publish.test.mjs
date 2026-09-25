/**
 * Tests for the automated publish: writing url.json, then committing and
 * pushing exactly that file.
 *
 * The publish is the last step of a recovery and the only one that writes to the
 * repository, so the properties worth pinning are the ones whose failure is
 * silent:
 *
 *  - a push that fails must be a publish that failed, not a line in a log. A
 *    rebuilt runtime whose address was never pushed is a runtime no installed APK
 *    can find, which is the whole point of the recovery.
 *  - only url.json may be committed. An automated commit that swallowed a stray
 *    edit would publish things nobody reviewed.
 *  - no credential may reach url.json, which is world-readable by design.
 *
 * Every test here drives the real publisher against a real git repository
 * created in a temp directory with a bare "remote" beside it, so the commit and
 * the push actually happen. Nothing is mocked: the assertions read what git
 * really recorded.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { makePublisher } from '../src/watchdog.mjs';

/** Runs a command and returns its exit code and output. */
function run(command, args, { cwd, env } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env } });
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

async function git(args, options) {
  const result = await run('git', args, options);
  assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

const tempDirs = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A URL that answers /api/health with a valid My AI Studio document. */
async function startStudio() {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ ok: true, service: 'my-ai-studio', version: '1.0.0' }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

/**
 * Builds a working repository, a bare remote, and an origin pointing at it, which
 * is what makes the push in the publisher a real push rather than a no-op.
 *
 * `scripts/url-json-update.mjs` is copied in because the publisher shells out to
 * it: the real script is what must run, not a stand-in for it.
 */
async function makeRepo({ withRemote = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-'));
  tempDirs.push(dir);

  const repo = join(dir, 'repo');
  await mkdir(repo);
  await git(['init', '--quiet', '--initial-branch=main', repo], {});
  await git(['config', 'user.email', 'test@example.invalid'], { cwd: repo });
  await git(['config', 'user.name', 'test'], { cwd: repo });

  await writeFile(
    join(repo, 'url.json'),
    `${JSON.stringify({ schema: 1, service: 'my-ai-studio', url: 'https://old.example', previousUrl: null, updatedAt: '2026-01-01T00:00:00.000Z', status: 'online' }, null, 2)}\n`,
  );
  // A second tracked file, so "only url.json changed" is a real distinction and
  // not just an empty repository.
  await writeFile(join(repo, 'README.md'), 'fixture\n');

  const scriptDir = join(repo, 'scripts');
  await mkdir(scriptDir);
  // ../.. from watchdog/tests is the repository root.
  const real = new URL('../../scripts/url-json-update.mjs', import.meta.url);
  await writeFile(join(scriptDir, 'url-json-update.mjs'), await readFile(real, 'utf8'));

  await git(['add', '.'], { cwd: repo });
  await git(['commit', '--quiet', '-m', 'fixture'], { cwd: repo });

  if (!withRemote) return { repo, remote: null };

  const remote = join(dir, 'remote.git');
  await git(['init', '--quiet', '--bare', remote], {});
  await git(['remote', 'add', 'origin', remote], { cwd: repo });
  await git(['push', '--quiet', 'origin', 'main'], { cwd: repo });
  return { repo, remote };
}

/** The url.json a repository currently holds, parsed. */
async function readUrlJson(repo) {
  return JSON.parse(await readFile(join(repo, 'url.json'), 'utf8'));
}

/** Commits on the remote's main branch, newest first. */
async function remoteLog(remote) {
  const result = await git(['log', '--format=%s', 'main'], { cwd: remote });
  return result.stdout.trim().split('\n').filter(Boolean);
}

describe('publishing commits and pushes url.json', () => {
  it('writes, commits and pushes the verified URL', async () => {
    const { repo, remote } = await makeRepo();
    const studio = await startStudio();

    try {
      const publish = makePublisher({ repoRoot: repo, dryRun: false });
      await publish(studio.url);

      // Written.
      const written = await readUrlJson(repo);
      assert.equal(written.url, studio.url);
      assert.equal(written.service, 'my-ai-studio');

      // Committed, under a message that names the address and nothing else.
      const local = await git(['log', '--format=%s', '-1'], { cwd: repo });
      assert.match(local.stdout.trim(), /^chore\(watchdog\): publish studio url http:\/\/127\.0\.0\.1:\d+$/);

      // Pushed: the commit is on the remote, not just in the local clone. This is
      // the assertion that "publishing" really happened.
      const subjects = await remoteLog(remote);
      assert.equal(subjects.length, 2, 'the publish did not reach the remote');
      assert.match(subjects[0], /^chore\(watchdog\): publish studio url /);
    } finally {
      studio.server.close();
    }
  });

  it('commits nothing but url.json', async () => {
    const { repo, remote } = await makeRepo();
    const studio = await startStudio();

    try {
      await makePublisher({ repoRoot: repo, dryRun: false })(studio.url);

      const changed = await git(['show', '--name-only', '--format=', 'HEAD'], { cwd: repo });
      assert.deepEqual(changed.stdout.trim().split('\n').filter(Boolean), ['url.json']);
      // And on the remote too, since that is the copy that matters.
      const onRemote = await git(['show', '--name-only', '--format=', 'main'], { cwd: remote });
      assert.deepEqual(onRemote.stdout.trim().split('\n').filter(Boolean), ['url.json']);
    } finally {
      studio.server.close();
    }
  });

  it('refuses to commit when another file is staged', async () => {
    // The danger this guards: an automated `git add .` that swept up whatever a
    // previous step left behind and published it unreviewed.
    const { repo, remote } = await makeRepo();
    const studio = await startStudio();

    try {
      await writeFile(join(repo, 'sneaky.txt'), 'not reviewed\n');
      await git(['add', '--', 'sneaky.txt'], { cwd: repo });

      await assert.rejects(
        () => makePublisher({ repoRoot: repo, dryRun: false })(studio.url),
        /refusing to commit files other than url\.json: sneaky\.txt/,
      );

      // Nothing was committed: the remote still holds only the fixture commit.
      assert.equal((await remoteLog(remote)).length, 1, 'a foreign file was committed');

      // And the index was left clean rather than half-staged for the next step.
      const staged = await git(['diff', '--cached', '--name-only'], { cwd: repo });
      assert.equal(staged.stdout.trim(), '', 'the publisher left files staged');
      // url.json was rolled back too, so the tree is exactly as it was found.
      const rolledBack = await readUrlJson(repo);
      assert.equal(rolledBack.url, 'https://old.example');
    } finally {
      studio.server.close();
    }
  });

  it('reports a rejected push as a publish failure', async () => {
    // A push that fails must be a publish that failed, not a line in a log. The
    // local commit exists by this point; what matters is that the caller is told
    // the publish did not land, with a stage, so it is not mistaken for success.
    const { repo } = await makeRepo();
    // The remote is removed after the fixture push, so `git push` has nowhere to
    // go and fails for the same reason a rejected push does.
    await git(['remote', 'set-url', 'origin', '/nonexistent/remote.git'], { cwd: repo });
    const studio = await startStudio();

    try {
      await assert.rejects(
        () => makePublisher({ repoRoot: repo, dryRun: false })(studio.url),
        (err) => {
          assert.match(err.message, /git push to main failed/);
          // The failure carries a stage, which is what the caller reports to
          // distinguish "the watchdog could not publish" from "the studio is
          // unwell".
          assert.equal(err.stage, 'publish');
          return true;
        },
      );
    } finally {
      studio.server.close();
    }
  });

  it('does nothing to the repository in dry-run', async () => {
    const { repo, remote } = await makeRepo();
    const studio = await startStudio();

    try {
      await makePublisher({ repoRoot: repo, dryRun: true })(studio.url);

      const untouched = await readUrlJson(repo);
      assert.equal(untouched.url, 'https://old.example', 'dry-run wrote url.json');
      const status = await git(['status', '--porcelain'], { cwd: repo });
      assert.equal(status.stdout.trim(), '', 'dry-run left changes behind');
      assert.equal((await remoteLog(remote)).length, 1);
    } finally {
      studio.server.close();
    }
  });

  it('bootstraps a committer identity when the checkout provides none', async () => {
    // actions/checkout does not set user.name/user.email. Without this, `git
    // commit` fails with "Author identity unknown" and the publish never lands -
    // and because the local fixtures usually set an identity, only a test that
    // deliberately removes it can catch that.
    const { repo, remote } = await makeRepo();
    const studio = await startStudio();

    try {
      // Unset both, and isolate the process from any global or system git config,
      // so the only identity available is the one the publisher bootstraps.
      await git(['config', '--unset', 'user.email'], { cwd: repo });
      await git(['config', '--unset', 'user.name'], { cwd: repo });

      const env = { ...process.env };
      for (const name of ['GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME']) {
        delete env[name];
      }
      env.GIT_CONFIG_GLOBAL = '/dev/null';
      env.GIT_CONFIG_SYSTEM = '/dev/null';
      const previous = process.env;
      process.env = env;
      try {
        await makePublisher({ repoRoot: repo, dryRun: false })(studio.url);
      } finally {
        process.env = previous;
      }

      // The commit happened and reached the remote.
      assert.equal((await remoteLog(remote)).length, 2, 'the publish did not reach the remote');
      const author = await git(['log', '--format=%an <%ae>', '-1'], { cwd: repo });
      assert.equal(author.stdout.trim(), 'my-ai-studio watchdog <watchdog@users.noreply.github.com>');
    } finally {
      studio.server.close();
    }
  });

  it('does not overwrite a committer identity that is already configured', async () => {
    // The other half of the bootstrap: a developer running the watchdog locally
    // must not have their own identity rewritten by an automated commit.
    const { repo } = await makeRepo();
    const studio = await startStudio();

    try {
      await makePublisher({ repoRoot: repo, dryRun: false })(studio.url);

      const author = await git(['log', '--format=%an <%ae>', '-1'], { cwd: repo });
      assert.equal(author.stdout.trim(), 'test <test@example.invalid>');
    } finally {
      studio.server.close();
    }
  });

  it('reports an unreachable URL as a publish failure, committing nothing', async () => {
    // url-json-update.mjs re-verifies the URL; its refusal must surface as a
    // failure rather than being mistaken for a successful publish.
    const { repo, remote } = await makeRepo();

    await assert.rejects(
      // Port 1 on loopback: connection refused, so the health probe cannot pass.
      () => makePublisher({ repoRoot: repo, dryRun: false })('http://127.0.0.1:1'),
      /url-json-update\.mjs exited 1/,
    );
    assert.equal((await remoteLog(remote)).length, 1, 'something was committed anyway');
  });

  it('leaves the repository unmodified when a foreign file blocks the publish', async () => {
    // The rollback path: url.json was already rewritten by the step 2 publisher
    // by the time the foreign file is noticed, so refusing must also undo that
    // write. Otherwise the next run starts from a tree that claims a URL nothing
    // was committed for.
    const { repo } = await makeRepo();
    const studio = await startStudio();

    try {
      await writeFile(join(repo, 'leftover.log'), 'from an earlier step\n');
      await git(['add', '--', 'leftover.log'], { cwd: repo });

      await assert.rejects(
        () => makePublisher({ repoRoot: repo, dryRun: false })(studio.url),
        /refusing to commit files other than url\.json/,
      );

      // Nothing is left staged, and url.json is back to what it was. The foreign
      // file itself is untouched: the publisher cleans up its own doing, not the
      // caller's.
      const staged = await git(['diff', '--cached', '--name-only'], { cwd: repo });
      assert.equal(staged.stdout.trim(), '', 'the publisher left files staged');
      const rolledBack = await readUrlJson(repo);
      assert.equal(rolledBack.url, 'https://old.example', 'url.json was left rewritten');
    } finally {
      studio.server.close();
    }
  });

  it('does not push a branch other than the one the APKs read', async () => {
    // The push target is explicit. Relying on upstream tracking would push
    // whatever branch CI happens to check out, which is not guaranteed to be the
    // branch url.json is served from.
    const { repo, remote } = await makeRepo();
    const studio = await startStudio();

    try {
      await makePublisher({ repoRoot: repo, dryRun: false })(studio.url);

      // The commit is on the remote's main, and no other branch was created.
      const branches = await git(['branch', '--format=%(refname:short)'], { cwd: remote });
      assert.deepEqual(branches.stdout.trim().split('\n').filter(Boolean), ['main']);
    } finally {
      studio.server.close();
    }
  });
});

describe('a rejected push still discards the recovered sandbox', () => {
  it('cleans up when the real publisher cannot push', async () => {
    // The end-to-end version of the property. The publisher here is the real one
    // and the push really fails, so this proves the failure unwinds through the
    // recovery's cleanup rather than being absorbed somewhere in between. Without
    // it, a rejected push would leave a running sandbox that nothing points at,
    // spending quota on every run.
    const { repo } = await makeRepo();
    // The remote is removed, so the commit succeeds and the push cannot.
    await git(['remote', 'set-url', 'origin', '/nonexistent/remote.git'], { cwd: repo });
    const studio = await startStudio();

    const { recoverStudio } = await import('../src/recovery.mjs');
    const { SandboxShell, ApiError, WORKER_PORTS } = await import('../src/openhandsClient.mjs');

    const calls = [];
    const sandbox = {
      id: 'sb-publish-test',
      status: 'RUNNING',
      session_api_key: 'session-key-value',
      exposed_urls: [
        { name: 'AGENT_SERVER', port: 60000, url: studio.url },
        // The public URL resolves to the local stand-in, so the recovery's own
        // public-health probe and the publisher's re-verification both pass and
        // the failure being tested is unambiguously the push.
        { name: 'WORKER_1', port: WORKER_PORTS.WORKER_1, url: studio.url },
      ],
    };
    const client = {
      async whoAmI() {
        calls.push('whoAmI');
        return { id: 'user' };
      },
      async startSandbox() {
        calls.push('startSandbox');
        return sandbox;
      },
      async getSandbox() {
        calls.push('getSandbox');
        return sandbox;
      },
      async deleteSandbox(id) {
        calls.push(`deleteSandbox:${id}`);
        return { success: true };
      },
    };

    const shell = {
      async run(command) {
        if (command.includes('127.0.0.1') && command.includes('/api/health')) {
          return { exitCode: 0, stdout: 'READY\n', stderr: '' };
        }
        if (command.includes('npm install')) return { exitCode: 0, stdout: 'EXIT=0', stderr: '' };
        if (command.includes('LAUNCHED')) return { exitCode: 0, stdout: 'LAUNCHED', stderr: '' };
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      /** The configuration arrives as a request body, never as a command. */
      async uploadFile() {
        return true;
      },
      async runChecked(command) {
        const result = await this.run(command);
        if (result.exitCode !== 0) throw new ApiError('command exited 1', { detail: result });
        return result;
      },
    };

    const originalRun = SandboxShell.prototype.run;
    const originalChecked = SandboxShell.prototype.runChecked;
    const originalUpload = SandboxShell.prototype.uploadFile;
    SandboxShell.prototype.run = (command, options) => shell.run(command, options);
    SandboxShell.prototype.runChecked = (command, options) => shell.runChecked(command, options);
    SandboxShell.prototype.uploadFile = () => shell.uploadFile();

    try {
      await assert.rejects(
        () =>
          recoverStudio({
            client,
            publish: makePublisher({ repoRoot: repo, dryRun: false }),
            sleep: async () => {},
            healthProbe: async () => ({ verdict: 'alive', ok: true, detail: 'service=my-ai-studio' }),
          }),
        (err) => {
          assert.match(err.message, /git push to main failed/);
          assert.equal(err.stage, 'publish new URL');
          return true;
        },
      );

      // The sandbox was discarded: the failed publish did not leave a runtime.
      assert.ok(calls.includes('deleteSandbox:sb-publish-test'), 'the sandbox was left running');
    } finally {
      SandboxShell.prototype.run = originalRun;
      SandboxShell.prototype.runChecked = originalChecked;
      SandboxShell.prototype.uploadFile = originalUpload;
      studio.server.close();
    }
  });
});

describe('publishing keeps credentials out of the repository', () => {
  it('never writes a token or credential into url.json', async () => {
    // url.json is served from raw.githubusercontent.com to every installed APK.
    // A secret here is published to the world, and the commit would carry it into
    // history where it cannot be unpublished.
    const { repo } = await makeRepo();
    const studio = await startStudio();

    const fixtures = {
      GITHUB_TOKEN: `ghp_${'F'.repeat(30)}`,
      OPENHANDS_API_KEY: `sk-${'openhands'.repeat(3)}`,
      OPENROUTER_API_KEY: `sk-or-v1-${'fixture'.repeat(4)}`,
      JWT_SECRET: `jwt-${'fixture'.repeat(3)}`,
      DATABASE_URL: ['postgres://', 'fixtureuser', ':', 'fixturepassword', '@127.0.0.1:5432/db'].join(''),
    };
    const previous = Object.fromEntries(Object.keys(fixtures).map((k) => [k, process.env[k]]));
    Object.assign(process.env, fixtures);

    try {
      await makePublisher({ repoRoot: repo, dryRun: false })(studio.url);

      const raw = await readFile(join(repo, 'url.json'), 'utf8');
      for (const [name, value] of Object.entries(fixtures)) {
        const sensitive = name === 'DATABASE_URL' ? 'fixturepassword' : value;
        assert.ok(!raw.includes(sensitive), `${name} was written into url.json`);
      }
      // The file still holds exactly the shape it is meant to.
      const parsed = JSON.parse(raw);
      assert.deepEqual(Object.keys(parsed).sort(), [
        'previousUrl',
        'schema',
        'service',
        'status',
        'updatedAt',
        'url',
      ]);

      // And the commit message carries no credential either.
      const subject = await git(['log', '--format=%B', '-1'], { cwd: repo });
      for (const value of Object.values(fixtures)) {
        assert.ok(!subject.stdout.includes(value), 'a credential reached the commit message');
      }
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      studio.server.close();
    }
  });

  it('redacts a credential that a git command writes to stderr', async () => {
    // A failing push can print the remote URL, and a remote URL can carry a
    // token. Inherited stdio would put that straight into the CI transcript, so
    // the publisher captures and redacts instead.
    const { repo } = await makeRepo();
    const studio = await startStudio();
    const token = `ghp_${'G'.repeat(30)}`;

    try {
      // The token is in the remote URL, which is the shape a misconfigured
      // checkout produces. `git push` to an unreachable host then echoes it.
      await git(['remote', 'set-url', 'origin', `https://${token}@127.0.0.1:1/repo.git`], { cwd: repo });

      const captured = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...rest) => {
        captured.push(String(chunk));
        return original(chunk, ...rest);
      };

      let error;
      try {
        await makePublisher({ repoRoot: repo, dryRun: false })(studio.url);
      } catch (err) {
        error = err;
      } finally {
        process.stderr.write = original;
      }

      assert.ok(error, 'the rejected push was not reported as a failure');
      assert.ok(
        !error.message.includes(token),
        'the token was echoed in the failure message',
      );
      assert.ok(
        !captured.join('').includes(token),
        'the token was written to the log',
      );
    } finally {
      studio.server.close();
    }
  });
});
