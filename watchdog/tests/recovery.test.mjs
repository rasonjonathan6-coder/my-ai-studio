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
    assert.doesNotMatch(command, /JWT_SECRET=[A-Za-z0-9+/]{16}/);
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

  it('sends no credential to the sandbox', async () => {
    process.env.JWT_SECRET = 'a-very-secret-signing-key-value-1234';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-secretsecretsecretsecret';
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
      assert.doesNotMatch(joined, /a-very-secret-signing-key-value/);
      assert.doesNotMatch(joined, /sk-or-v1-secretsecret/);
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
