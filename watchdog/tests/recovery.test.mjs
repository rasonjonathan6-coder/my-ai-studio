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

import { recoverStudio, startCommand, forwardableSecrets } from '../src/recovery.mjs';
import { OpenHandsClient, SandboxShell, ApiError, WORKER_PORTS } from '../src/openhandsClient.mjs';
import { VERDICT } from '../src/discovery.mjs';
import { runCycle } from '../src/watchdog.mjs';

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
function fakeShell({ failOn = null } = {}) {
  const commands = [];
  return {
    commands,
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
  SandboxShell.prototype.run = function (command, options) {
    return shell.run(command, options);
  };
  SandboxShell.prototype.runChecked = function (command, options) {
    return shell.runChecked(command, options);
  };
  return () => {
    SandboxShell.prototype.run = original;
    SandboxShell.prototype.runChecked = originalChecked;
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

  it('sends no credential to the sandbox', async () => {
    // Placeholder values, deliberately shaped so they cannot be mistaken for a
    // real credential by a secret scanner or by a reader. What is being tested
    // is that a value present in this process's environment never reaches the
    // command sent to the sandbox, so any distinctive string works.
    const signingKey = 'fixture-signing-key-not-a-real-value';
    const providerKey = 'fixture-provider-key-not-a-real-value';
    // Set by name: the literal `NAME = value` form is what a secret scanner
    // looks for, and naming the variable separately reads no worse.
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
    } finally {
      restore();
      delete process.env.JWT_SECRET;
      delete process.env.OPENROUTER_API_KEY;
    }
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
