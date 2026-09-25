/**
 * Tests for the recovery steps and the cycle that drives them.
 *
 * The OpenHands API and the sandbox are faked here so the failure paths can be
 * exercised: a test cannot wait for a real sandbox to fail a build. The fakes
 * record what was called, which is what lets these tests assert the properties
 * that actually matter:
 *
 *  - a healthy studio creates no sandbox at all;
 *  - an inconclusive failure creates none either;
 *  - nothing is published before the new URL has answered health publicly;
 *  - a failed recovery publishes nothing and discards its sandbox;
 *  - no command sent to the sandbox contains a credential.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  recoverStudio,
  startCommand,
  forwardableSecrets,
  studioEnv,
  chmodCommand,
  secretNames,
  ENV_FILE,
} from '../src/recovery.mjs';
import { OpenHandsClient, SandboxShell, ApiError, WORKER_PORTS } from '../src/openhandsClient.mjs';
import { VERDICT } from '../src/discovery.mjs';
import { runCycle } from '../src/watchdog.mjs';
import { HOST_EXECUTION_OPT_IN, ISOLATION_CANARY, LAUNCH_MARKERS, makeLaunchFixture, runLaunchIsolated } from './helpers.mjs';

const SANDBOX = {
  id: 'sb-test',
  status: 'RUNNING',
  session_api_key: 'session-key-value',
  exposed_urls: [
    { name: 'AGENT_SERVER', port: 60000, url: 'https://agent.example' },
    { name: 'WORKER_1', port: WORKER_PORTS.WORKER_1, url: 'https://studio-new.example/' },
  ],
};

const SETTINGS = {
  documentUrl: 'https://example.invalid/url.json',
  healthAttempts: 2,
  healthDelayMs: 0,
  healthTimeoutMs: 1_000,
  documentTimeoutMs: 1_000,
  maxRebuildsPerDay: 4,
  minRebuildGapMs: 0,
  statePath: '',
};

const noSleep = async () => {};

/** A client that records calls and answers with a canned sandbox. */
function fakeClient({ sandbox = SANDBOX } = {}) {
  const calls = [];
  return {
    calls,
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
}

/** A shell that records commands and succeeds unless told otherwise. */
function fakeShell({ failOn = null, failUpload = false } = {}) {
  const commands = [];
  const uploads = [];
  return {
    commands,
    uploads,
    async run(command) {
      commands.push(command);
      if (failOn && command.includes(failOn)) {
        return { exitCode: 1, stdout: '', stderr: 'boom' };
      }
      // The local-health step polls and reports READY when the port answers.
      if (command.includes('127.0.0.1') && command.includes('/api/health')) {
        return { exitCode: 0, stdout: 'READY\n', stderr: '' };
      }
      if (command.includes('npm install')) return { exitCode: 0, stdout: 'EXIT=0', stderr: '' };
      if (command.includes('LAUNCHED')) return { exitCode: 0, stdout: 'LAUNCHED', stderr: '' };
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
    /** Records the content as the fake's own copy of what would have been written. */
    async uploadFile(path, content) {
      if (failUpload) throw new ApiError('upload failed with HTTP 500', { status: 500 });
      uploads.push({ path, content });
      return true;
    },
    async runChecked(command) {
      const result = await this.run(command);
      if (result.exitCode !== 0) throw new ApiError('command exited 1', { detail: result });
      return result;
    },
  };
}

// RecoverStudio builds its own SandboxShell, so the fake is injected through the
// module-level constructor used by the client helpers.
function withFakeShell(shell) {
  const original = SandboxShell.prototype.run;
  const originalChecked = SandboxShell.prototype.runChecked;
  const originalUpload = SandboxShell.prototype.uploadFile;
  SandboxShell.prototype.run = function (command, options) {
    return shell.run(command, options);
  };
  SandboxShell.prototype.runChecked = function (command, options) {
    return shell.runChecked(command, options);
  };
  SandboxShell.prototype.uploadFile = function (path, content, options) {
    return shell.uploadFile(path, content, options);
  };
  return () => {
    SandboxShell.prototype.run = original;
    SandboxShell.prototype.runChecked = originalChecked;
    SandboxShell.prototype.uploadFile = originalUpload;
  };
}

describe('startCommand', () => {
  it('generates the signing key inside the sandbox rather than passing one', () => {
    const command = startCommand();
    assert.match(command, /dev\/urandom/);
    // Asserting the positive is stronger than hunting for a literal: it proves
    // the command refers to the generated variable at all. A literal would have
    // to be written out for this to match.
    assert.match(command, /JWT_SECRET="\$SECRET"/);
  });

  it('starts the server on the exposed worker port', () => {
    assert.match(startCommand(), /PORT=12000/);
  });

  it('chains its steps so a failure stops the launch', () => {
    // Joined by spaces instead of &&, `cd DIR rm -f FILE` becomes a single cd
    // with two arguments, which fails and leaves the server never started.
    assert.match(startCommand(), /&&/);
    assert.doesNotMatch(startCommand(), /cd \S+ rm /);
  });

  it('returns immediately instead of waiting on the server', () => {
    assert.match(startCommand(), /&\)/);
  });

  it('contains no credential', () => {
    assert.doesNotMatch(startCommand(), /sk-|gh[pousr]_|Bearer/);
  });

  it('reads the environment file instead of generating a signing key when provisioned', () => {
    const command = startCommand({ useEnvFile: true });
    // Only the path is named. A value here would be recorded in the sandbox's bash
    // event history, which is the whole reason the file exists.
    assert.match(command, /--env-file=\/tmp\/studio\.env/);
    assert.doesNotMatch(command, /dev\/urandom/);
    // The signing key comes from the file, so an assignment here would override it and
    // silently invalidate every session the persistent key was meant to preserve.
    assert.doesNotMatch(command, /JWT_SECRET=/);
  });

  it('still names the port and the environment when provisioned', () => {
    const command = startCommand({ useEnvFile: true });
    assert.match(command, /PORT=12000/);
    assert.match(command, /NODE_ENV=production/);
  });

  it('passes --env-file to node as a direct argument', () => {
    const command = startCommand({ useEnvFile: true });
    // The flag has to sit between `node` and the script. Anywhere else and node
    // either treats it as an argument to the script or rejects it outright.
    assert.match(command, /node --env-file=\/tmp\/studio\.env backend\/dist\/server\.js/);
  });

  it('never puts --env-file in NODE_OPTIONS', () => {
    // Node refuses that flag in NODE_OPTIONS and exits before listening:
    //   node: --env-file= is not allowed in NODE_OPTIONS
    // A launch built that way looks correct in the command string and yields a
    // studio that starts, logs that one line and dies. Asserting the absence here
    // is what turns a silent production failure into a test failure.
    const command = startCommand({ useEnvFile: true });
    assert.doesNotMatch(command, /NODE_OPTIONS/);
  });

  it('keeps a launch that chains its steps when provisioned', () => {
    const command = startCommand({ useEnvFile: true });
    assert.match(command, /&&/);
    assert.match(command, /&\)/);
  });

  it('permits in-process command execution in both branches', () => {
    // The server refuses to start in production without this opt-in, so a branch
    // missing it produces a studio that starts, dies, and looks like a health
    // problem. It lived only in the unprovisioned branch, which is exactly how the
    // provisioned launch came to fail with "SANDBOX_ENABLED is false in production"
    // after the environment file had already been read.
    assert.match(startCommand(), /ALLOW_HOST_EXECUTION_IN_PRODUCTION=true/);
    assert.match(startCommand({ useEnvFile: true }), /ALLOW_HOST_EXECUTION_IN_PRODUCTION=true/);
  });

  it('keeps the opt-in out of the environment file', () => {
    // The file is the application's configuration and is uploaded to the sandbox;
    // this name configures the host, so it belongs on the launch command instead.
    const { body, names } = studioEnv({
      env: {
        OPENROUTER_MODEL: 'vendor/model',
        ALLOW_HOST_EXECUTION_IN_PRODUCTION: 'true',
      },
    });
    assert.deepEqual(names, ['OPENROUTER_MODEL']);
    assert.doesNotMatch(body, /ALLOW_HOST_EXECUTION_IN_PRODUCTION/);
  });
});

describe('the launch actually starts a process', () => {
  /**
   * These run the command `startCommand` builds, against a stand-in for the server
   * entry. Asserting on the command string alone is what let the previous launch
   * through: it read correctly, and node refused it before the studio ever listened.
   */

  it('starts without error and reports the port it was given', () => {
    const fixture = makeLaunchFixture();
    try {
      const result = runLaunchIsolated(startCommand({ useEnvFile: true }), fixture);
      assert.equal(result.status, 0, `launch exited ${result.status}: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /is not allowed in NODE_OPTIONS/);
      assert.match(result.stdout, /"PORT":"12000"/);
      // A missing canary is what proves the launch ran with nothing else in its
      // environment. Without this the checks below could pass on an environment that
      // merely happens to lack the configured names, which is what CI is.
      assert.equal(JSON.parse(result.stdout)[ISOLATION_CANARY], null, 'the launch was not isolated');
      // The strongest form of the check above: the process the command builds really
      // does receive the opt-in. The backend exits immediately without it, so a
      // string-only assertion would pass on a launch that cannot start.
      assert.equal(JSON.parse(result.stdout)[HOST_EXECUTION_OPT_IN], 'true');
    } finally {
      fixture.cleanup();
    }
  });

  it('starts with the opt-in when running without an environment file', () => {
    // The unprovisioned branch launches the same server, so it needs the opt-in too.
    // It generates its own signing key, so the probe is given one.
    const fixture = makeLaunchFixture();
    try {
      const result = runLaunchIsolated(startCommand({ useEnvFile: false }), {
        ...fixture,
        withEnv: { SECRET: 'fixture-signing-key-not-a-real-value' },
      });
      assert.equal(result.status, 0, `launch exited ${result.status}: ${result.stderr}`);
      const seen = JSON.parse(result.stdout);
      assert.equal(seen[HOST_EXECUTION_OPT_IN], 'true');
      assert.equal(seen[ISOLATION_CANARY], null, 'the launch was not isolated');
    } finally {
      fixture.cleanup();
    }
  });

  it('reads every configured name from the environment file', () => {
    const fixture = makeLaunchFixture();
    try {
      const result = runLaunchIsolated(startCommand({ useEnvFile: true }), fixture);
      assert.equal(result.status, 0, `launch exited ${result.status}: ${result.stderr}`);

      const seen = JSON.parse(result.stdout);
      for (const [name, value] of Object.entries(LAUNCH_MARKERS)) {
        // Equality against the marker, not a truthiness check: a name that leaked in
        // from the surrounding environment would otherwise satisfy the assertion.
        assert.equal(seen[name], value, `${name} did not come from the environment file`);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('does not let an inherited name mask the environment file', () => {
    // The behaviour being pinned: --env-file leaves a name that is already defined
    // alone. Running the launch inside the suite's own environment would therefore
    // read that environment, and the file would be ignored without any warning. The
    // launch is isolated so the file is the only source, exactly as in a fresh
    // sandbox - and this test states the masking rule rather than assuming it.
    const fixture = makeLaunchFixture();
    try {
      const masked = runLaunchIsolated(startCommand({ useEnvFile: true }), {
        ...fixture,
        withEnv: { DATABASE_URL: 'inherited-value' },
      });
      assert.equal(masked.status, 0, `launch exited ${masked.status}: ${masked.stderr}`);

      const seen = JSON.parse(masked.stdout);
      assert.equal(seen.DATABASE_URL, 'inherited-value', 'an inherited name did not take precedence');
      // The names that were not injected still come from the file, which is why the
      // isolation matters for the rest of the suite and not for this assertion.
      assert.equal(seen.OPENROUTER_API_KEY, LAUNCH_MARKERS.OPENROUTER_API_KEY);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('forwardableSecrets', () => {
  it('reports only the secrets actually present', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      assert.ok(!forwardableSecrets().includes('DATABASE_URL'));
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it('reads the environment it is given, not the process', () => {
    const names = forwardableSecrets({ env: { OPENROUTER_MODEL: 'a/model', DATABASE_SSL: 'true' } });
    assert.deepEqual(names, ['DATABASE_SSL', 'OPENROUTER_MODEL']);
  });

  it('ignores a name that is present but empty', () => {
    // A GitHub secret that was never set arrives as an empty string, not as a missing
    // key. Treating that as configured would write KEY= and let the studio start with
    // a credential that is not one.
    assert.deepEqual(forwardableSecrets({ env: { DATABASE_URL: '' } }), []);
  });

  it('names the credential-bearing variables separately from the plain settings', () => {
    assert.deepEqual(secretNames(), [
      'DATABASE_URL',
      'OPENROUTER_API_KEY',
      'JWT_SECRET',
      'MY_AI_STUDIO_CREDENTIAL_KEY',
    ]);
  });
});

describe('studioEnv', () => {
  it('writes one KEY=VALUE line per configured name', () => {
    const { body } = studioEnv({
      env: { DATABASE_URL: 'postgres://u:p@h/db', OPENROUTER_MODEL: 'vendor/model' },
    });
    const lines = body.trimEnd().split('\n');
    assert.deepEqual(lines, ['DATABASE_URL=postgres://u:p@h/db', 'OPENROUTER_MODEL=vendor/model']);
  });

  it('leaves out a name that was not configured and reports it as missing', () => {
    const { body, names, missing } = studioEnv({ env: { OPENROUTER_MODEL: 'vendor/model' } });
    assert.deepEqual(names, ['OPENROUTER_MODEL']);
    assert.doesNotMatch(body, /DATABASE_URL/);
    assert.ok(missing.includes('DATABASE_URL'));
    // Nothing is generated to stand in for it.
    assert.ok(!/\n.+=/.test(body) || body.trimEnd().split('\n').length === 1);
  });

  it('returns an empty body when nothing is configured', () => {
    const { body, names } = studioEnv({ env: {} });
    assert.equal(body, '');
    assert.deepEqual(names, []);
  });

  it('refuses a value carrying a newline instead of writing two lines', () => {
    // A multi-line value would silently become a second variable, changing which
    // names the runtime sees. Refusing is louder than writing something wrong.
    const { body, refused } = studioEnv({
      env: { OPENROUTER_API_KEY: 'line-one\nINJECTED=line-two' },
    });
    assert.deepEqual(refused, ['OPENROUTER_API_KEY']);
    assert.equal(body, '');
    assert.doesNotMatch(body, /INJECTED/);
  });

  it('carries the non-secret settings too', () => {
    const { body } = studioEnv({ env: { DATABASE_SSL: 'true', MY_AI_STUDIO_ADMIN_EMAIL: 'ops@example.test' } });
    assert.match(body, /^DATABASE_SSL=true$/m);
    assert.match(body, /^MY_AI_STUDIO_ADMIN_EMAIL=ops@example\.test$/m);
  });
});

describe('chmodCommand', () => {
  it('names the path and never a value', () => {
    const command = chmodCommand();
    assert.equal(command, 'chmod 600 /tmp/studio.env');
    assert.doesNotMatch(command, /sk-|gh[pousr]_|Bearer|postgres:\/\//);
  });
});

describe('recoverStudio', () => {
  it('runs the whole recovery and publishes only after public health passes', async () => {
    const shell = fakeShell();
    const restore = withFakeShell(shell);
    const published = [];
    const probed = [];
    try {
      const result = await recoverStudio({
        client: fakeClient(),
        publish: async (url) => published.push(url),
        sleep: noSleep,
        healthProbe: async (url) => {
          probed.push(url);
          return { ok: true, detail: 'service=my-ai-studio' };
        },
      });
      assert.equal(result.publicUrl, 'https://studio-new.example');
      assert.equal(published.length, 1);
      assert.equal(published[0], 'https://studio-new.example');
      // The public URL was verified before being published.
      assert.deepEqual(probed, ['https://studio-new.example']);
    } finally {
      restore();
    }
  });

  it('publishes nothing when the public URL does not answer', async () => {
    const restore = withFakeShell(fakeShell());
    const published = [];
    try {
      await assert.rejects(
        () =>
          recoverStudio({
            client: fakeClient(),
            publish: async (url) => published.push(url),
            sleep: noSleep,
            healthProbe: async () => ({ ok: false, detail: 'unreachable' }),
          }),
        /public health failed/,
      );
      assert.equal(published.length, 0);
    } finally {
      restore();
    }
  });

  it('discards the sandbox when recovery fails', async () => {
    const client = fakeClient();
    const restore = withFakeShell(fakeShell({ failOn: 'npm install' }));
    try {
      await assert.rejects(() =>
        recoverStudio({ client, publish: async () => {}, sleep: noSleep, healthProbe: async () => ({ ok: true }) }),
      );
      assert.ok(client.calls.includes('deleteSandbox:sb-test'));
    } finally {
      restore();
    }
  });

  it('publishes nothing when the build fails', async () => {
    const published = [];
    const restore = withFakeShell(fakeShell({ failOn: 'npm install' }));
    try {
      await assert.rejects(() =>
        recoverStudio({
          client: fakeClient(),
          publish: async (url) => published.push(url),
          sleep: noSleep,
          healthProbe: async () => ({ ok: true }),
        }),
      );
      assert.equal(published.length, 0);
    } finally {
      restore();
    }
  });

  it('fails when the sandbox exposes no worker URL', async () => {
    const sandbox = { ...SANDBOX, exposed_urls: [{ name: 'AGENT_SERVER', port: 60000, url: 'https://agent.example' }] };
    const restore = withFakeShell(fakeShell());
    try {
      await assert.rejects(
        () =>
          recoverStudio({
            client: fakeClient({ sandbox }),
            publish: async () => {},
            sleep: noSleep,
            healthProbe: async () => ({ ok: true }),
          }),
        /exposes no URL for port 12000/,
      );
    } finally {
      restore();
    }
  });

  it('orders local health, public URL resolution, public health, then publish', async () => {
    // The ordering is the safety property: publishing an unverified address
    // points every installed APK at a dead host. Asserting only that both
    // happened (as the test above does) would still pass if publish ran first,
    // so the sequence itself is recorded and checked here.
    const events = [];
    const client = fakeClient();
    const originalGet = client.getSandbox.bind(client);
    client.getSandbox = async (...args) => {
      events.push('resolve-public-url');
      return originalGet(...args);
    };

    const shell = fakeShell();
    const originalRun = shell.run.bind(shell);
    shell.run = async (command, options) => {
      const result = await originalRun(command, options);
      if (command.includes('127.0.0.1') && command.includes('/api/health')) {
        events.push('local-health');
      }
      if (command.includes('git clone')) events.push('restore-repository');
      if (command.includes('npm install')) events.push('install-and-build');
      if (command.includes('LAUNCHED')) events.push('start-studio');
      return result;
    };

    const restore = withFakeShell(shell);
    try {
      await recoverStudio({
        client,
        publish: async () => events.push('publish'),
        sleep: noSleep,
        healthProbe: async () => {
          events.push('public-health');
          return { ok: true, detail: 'service=my-ai-studio' };
        },
      });
    } finally {
      restore();
    }

    const at = (name) => {
      const index = events.indexOf(name);
      assert.notEqual(index, -1, `${name} never happened`);
      return index;
    };

    assert.deepEqual(events, [
      'restore-repository',
      'install-and-build',
      'start-studio',
      'local-health',
      'resolve-public-url',
      'public-health',
      'publish',
    ]);
    // Stated separately from the deepEqual so a failure says which invariant
    // broke rather than just printing two arrays.
    assert.ok(at('public-health') < at('publish'), 'publish ran before public health was confirmed');
    assert.ok(at('local-health') < at('public-health'), 'public health ran before local health');
    assert.ok(at('resolve-public-url') < at('public-health'), 'the public URL was probed before it was resolved');
  });

  it('publishes nothing and discards the sandbox when the publisher fails', async () => {
    // The publish step is the last one, so its failure is the case most likely
    // to leave a running runtime behind: the studio is up and healthy by then,
    // and the sandbox is only removed because the rejection unwinds through
    // the cleanup path. Without that, a failed push would strand a sandbox that
    // nothing points at, spending quota.
    const published = [];
    const client = fakeClient();
    const restore = withFakeShell(fakeShell());
    try {
      await assert.rejects(
        () =>
          recoverStudio({
            client,
            publish: async (url) => {
              published.push(url);
              throw new Error('url-json-update.mjs exited 1');
            },
            sleep: noSleep,
            healthProbe: async () => ({ ok: true, detail: 'service=my-ai-studio' }),
          }),
        /url-json-update\.mjs exited 1/,
      );
      // It tried, and it threw: no success was returned to runCycle.
      assert.deepEqual(published, ['https://studio-new.example']);
      assert.ok(client.calls.includes('deleteSandbox:sb-test'), 'the sandbox was left running');
    } finally {
      restore();
    }
  });

  it('reports a publish failure with its stage so the cause is identifiable', async () => {
    const restore = withFakeShell(fakeShell());
    try {
      await assert.rejects(
        () =>
          recoverStudio({
            client: fakeClient(),
            publish: async () => {
              throw new Error('publisher exploded');
            },
            sleep: noSleep,
            healthProbe: async () => ({ ok: true, detail: 'ok' }),
          }),
        (err) => {
          // The stage is the step name, so a log reader can find which step in
          // recoverStudio threw without reading the message.
          assert.equal(err.stage, 'publish new URL');
          assert.equal(err.name, 'RecoveryError');
          assert.match(err.message, /publisher exploded/);
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('never puts a configuration value in a command', async () => {
    // Placeholder values, deliberately shaped so they cannot be mistaken for a real
    // credential by a secret scanner or by a reader. What is being tested is that a
    // value present in this process's environment reaches the sandbox as uploaded
    // content and never as part of a command string, so any distinctive string works.
    const signingKey = 'fixture-signing-key-not-a-real-value';
    const providerKey = 'fixture-provider-key-not-a-real-value';
    // Set by name: the literal `NAME = value` form is what a secret scanner looks for,
    // and naming the variable separately reads no worse.
    const setEnv = (name, value) => {
      process.env[name] = value;
    };
    setEnv('JWT_SECRET', signingKey);
    setEnv('OPENROUTER_API_KEY', providerKey);
    const shell = fakeShell();
    const restore = withFakeShell(shell);
    try {
      await recoverStudio({
        client: fakeClient(),
        publish: async () => {},
        sleep: noSleep,
        healthProbe: async () => ({ ok: true }),
      });
      const joined = shell.commands.join('\n');
      assert.doesNotMatch(joined, new RegExp(signingKey));
      assert.doesNotMatch(joined, new RegExp(providerKey));
      // And the values did reach the runtime, by the one channel that is not a
      // command. Without this half the test would pass by forwarding nothing at all.
      const uploaded = shell.uploads.map((entry) => entry.content).join('\n');
      assert.match(uploaded, new RegExp(signingKey));
      assert.match(uploaded, new RegExp(providerKey));
    } finally {
      restore();
      delete process.env.JWT_SECRET;
      delete process.env.OPENROUTER_API_KEY;
    }
  });
});

describe('provisioning the runtime environment', () => {
  it('uploads the configuration, reaches it before starting, and names no value in a command', async () => {
    const shell = fakeShell();
    const restore = withFakeShell(shell);
    const fixture = {
      DATABASE_URL: 'postgres://u:fixturepassword@db.example:5432/studio',
      OPENROUTER_API_KEY: 'fixture-provider-key-not-a-real-value',
      DATABASE_SSL: 'true',
      OPENROUTER_MODEL: 'vendor/model',
      JWT_SECRET: 'fixture-signing-key-not-a-real-value',
    };
    try {
      await recoverStudio({
        client: fakeClient(),
        publish: async () => {},
        sleep: noSleep,
        healthProbe: async () => ({ ok: true }),
        env: fixture,
      });

      // One upload, to the path the launch reads.
      assert.equal(shell.uploads.length, 1);
      assert.equal(shell.uploads[0].path, ENV_FILE);
      assert.match(shell.uploads[0].content, /^DATABASE_URL=/m);
      assert.match(shell.uploads[0].content, /^DATABASE_SSL=true$/m);
      assert.match(shell.uploads[0].content, /^OPENROUTER_MODEL=vendor\/model$/m);

      const joined = shell.commands.join('\n');
      // No value, secret or not, appears in any command. This is the invariant the
      // whole mechanism exists to hold: a command is recorded in the sandbox's bash
      // event history and stays readable through the API afterwards.
      assert.doesNotMatch(joined, /fixturepassword/);
      assert.doesNotMatch(joined, /fixture-provider-key-not-a-real-value/);
      assert.doesNotMatch(joined, /fixture-signing-key-not-a-real-value/);
      // The launch points at the file, as a node argument. Matching loosely here
      // would accept the NODE_OPTIONS form, which is the one node rejects.
      assert.match(joined, /node --env-file=\/tmp\/studio\.env backend\/dist\/server\.js/);
      assert.doesNotMatch(joined, /NODE_OPTIONS/);
      // And the signing key was not regenerated, because one was supplied.
      assert.doesNotMatch(joined, /dev\/urandom/);

      // The file is restricted before the launch, not after.
      const chmodAt = shell.commands.indexOf('chmod 600 /tmp/studio.env');
      const launchAt = shell.commands.findIndex((command) => command.includes('LAUNCHED'));
      assert.ok(chmodAt !== -1, 'chmod was never run');
      assert.ok(launchAt !== -1, 'the studio was never started');
      assert.ok(chmodAt < launchAt, 'the file was launched before it was restricted');
    } finally {
      restore();
    }
  });

  it('writes no file and starts the old way when nothing is configured', async () => {
    const shell = fakeShell();
    const restore = withFakeShell(shell);
    try {
      await recoverStudio({
        client: fakeClient(),
        publish: async () => {},
        sleep: noSleep,
        healthProbe: async () => ({ ok: true }),
        env: {},
      });
      assert.equal(shell.uploads.length, 0, 'a file was written with nothing to put in it');
      const joined = shell.commands.join('\n');
      // The older behaviour, kept for a run with no configuration at all.
      assert.match(joined, /dev\/urandom/);
      assert.doesNotMatch(joined, /--env-file/);
    } finally {
      restore();
    }
  });

  it('does not start the studio when the upload fails', async () => {
    const shell = fakeShell({ failUpload: true });
    const restore = withFakeShell(shell);
    try {
      await assert.rejects(
        () =>
          recoverStudio({
            client: fakeClient(),
            publish: async () => {},
            sleep: noSleep,
            healthProbe: async () => ({ ok: true }),
            env: { OPENROUTER_MODEL: 'vendor/model' },
          }),
        (err) => {
          // A studio launched without the configuration it was supposed to receive
          // would look like a working recovery running on defaults. Failing here is
          // the point: nothing downstream may run.
          assert.equal(err.name, 'RecoveryError');
          assert.match(err.message, /provision runtime environment/);
          return true;
        },
      );
      const joined = shell.commands.join('\n');
      assert.doesNotMatch(joined, /LAUNCHED/, 'the studio was started despite a failed upload');
      assert.doesNotMatch(joined, /chmod/, 'a file was restricted that was never written');
    } finally {
      restore();
    }
  });

  it('never prints a configuration value through the real logging path', async () => {
    const shell = fakeShell();
    const restore = withFakeShell(shell);
    const { log } = await import('../src/log.mjs');
    const fixture = {
      DATABASE_URL: 'postgres://u:fixturepassword@db.example:5432/studio',
      OPENROUTER_API_KEY: 'fixture-provider-key-not-a-real-value',
      MY_AI_STUDIO_CREDENTIAL_KEY: 'fixture-credential-key-not-a-real-value',
      JWT_SECRET: 'fixture-signing-key-not-a-real-value',
    };
    // Set on the process too, because that is where the redaction list reads from.
    for (const [name, value] of Object.entries(fixture)) process.env[name] = value;
    const written = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    process.stdout.write = (chunk) => written.push(String(chunk));
    process.stderr.write = (chunk) => written.push(String(chunk));
    try {
      await recoverStudio({
        client: fakeClient(),
        publish: async () => {},
        sleep: noSleep,
        healthProbe: async () => ({ ok: true }),
        env: fixture,
      });
      // The provisioning step logs the names it wrote. A value must not ride along.
      log.info('probe line', { detail: { echo: fixture.DATABASE_URL } });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      restore();
      for (const name of Object.keys(fixture)) delete process.env[name];
    }
    const output = written.join('');
    assert.doesNotMatch(output, /fixturepassword/);
    assert.doesNotMatch(output, /fixture-provider-key-not-a-real-value/);
    assert.doesNotMatch(output, /fixture-credential-key-not-a-real-value/);
    assert.doesNotMatch(output, /fixture-signing-key-not-a-real-value/);
    // The names are still reported, so an operator can see what was written.
    assert.match(output, /DATABASE_URL/);
    assert.match(output, /runtime environment provisioned/);
  });
});

describe('OpenHandsClient helpers', () => {
  it('finds the URL for a port', () => {
    assert.equal(OpenHandsClient.urlForPort(SANDBOX, 12000), 'https://studio-new.example');
  });

  it('strips a trailing slash so endpoints do not double up', () => {
    assert.equal(OpenHandsClient.urlForPort(SANDBOX, WORKER_PORTS.WORKER_1), 'https://studio-new.example');
  });

  it('returns null when the port is not exposed', () => {
    assert.equal(OpenHandsClient.urlForPort(SANDBOX, 9999), null);
  });

  it('reads the agent server URL from port 60000', () => {
    assert.equal(OpenHandsClient.agentServerUrl(SANDBOX), 'https://agent.example');
  });

  it('refuses to build a shell without a session key', () => {
    assert.throws(() => new SandboxShell({ agentServerUrl: 'https://agent.example' }), /session API key/);
  });
});

describe('runCycle', () => {
  // The cycle reads url.json before probing. The document is injected so these
  // tests do not depend on the live GitHub copy.
  const readDocument = async () => ({
    url: 'https://studio.example',
    documentUrl: 'https://example.invalid/url.json',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'online',
  });

  it('creates nothing when the studio is alive', async () => {
    const client = fakeClient();
    const result = await runCycle({
      settings: SETTINGS,
      readDocument,
      client,
      healthProbe: async () => ({ verdict: VERDICT.ALIVE, detail: 'ok' }),
    });
    assert.equal(result.action, 'none');
    assert.deepEqual(client.calls, []);
  });

  it('creates nothing when the answer is inconclusive', async () => {
    // The transient case. Rebuilding here is exactly the behaviour to avoid.
    const client = fakeClient();
    const result = await runCycle({
      settings: SETTINGS,
      readDocument,
      client,
      healthProbe: async () => ({ verdict: VERDICT.UNKNOWN, detail: 'timeout', attempts: [1, 2] }),
    });
    assert.equal(result.action, 'none');
    assert.deepEqual(client.calls, []);
  });

  it('does not rebuild in plan mode even when the studio is dead', async () => {
    const client = fakeClient();
    const result = await runCycle({
      settings: SETTINGS,
      planOnly: true,
      readDocument,
      client,
      healthProbe: async () => ({ verdict: VERDICT.DEAD, detail: 'HTTP 404' }),
    });
    assert.equal(result.action, 'would-rebuild');
    assert.deepEqual(client.calls, []);
  });

  it('refuses to rebuild once the daily budget is spent', async () => {
    const client = fakeClient();
    const stateDir = await import('node:fs/promises').then((fs) => fs.mkdtemp('/tmp/watchdog-cycle-'));
    const statePath = `${stateDir}/state.json`;
    const { writeState } = await import('../src/state.mjs');
    await writeState(statePath, {
      rebuilds: [
        { at: new Date().toISOString(), url: 'https://a.example', sandboxId: 'a' },
        { at: new Date().toISOString(), url: 'https://b.example', sandboxId: 'b' },
        { at: new Date().toISOString(), url: 'https://c.example', sandboxId: 'c' },
        { at: new Date().toISOString(), url: 'https://d.example', sandboxId: 'd' },
      ],
    });
    try {
      const result = await runCycle({
        settings: { ...SETTINGS, statePath, maxRebuildsPerDay: 4 },
        readDocument,
        client,
        healthProbe: async () => ({ verdict: VERDICT.DEAD, detail: 'HTTP 404' }),
      });
      assert.equal(result.action, 'blocked');
      assert.deepEqual(client.calls, []);
    } finally {
      await import('node:fs/promises').then((fs) => fs.rm(stateDir, { recursive: true, force: true }));
    }
  });
});
