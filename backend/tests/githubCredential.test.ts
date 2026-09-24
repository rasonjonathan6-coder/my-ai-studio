import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { config } from '../src/config/index.ts';
import {
  credentialInfo,
  fingerprintOf,
  matchesStored,
  probeCredential,
  resolvedToken,
  tokenKindOf,
  validateTokenShape,
} from '../src/services/githubCredential.ts';
import { credentialKind, getGithubStatus } from '../src/services/githubActions.ts';
import { redact } from '../src/lib/logger.ts';

/**
 * Tests for My AI Studio's own GitHub credential path.
 *
 * These pin the properties the integration depends on: the credential is
 * resolved from a source the app owns rather than from the host-injected
 * GITHUB_TOKEN, a stored credential outranks the environment, the token value
 * is never returned by any status shape, and a candidate credential is verified
 * with real HTTP requests whose result is reported honestly.
 *
 * The HTTP cases drive the real client against a local server, so the request
 * methods, paths and headers are exercised rather than described. No call
 * leaves the machine.
 */

const FINE_GRAINED = 'github_pat_11CJB7ERY' + 'a'.repeat(60);
const CLASSIC = 'ghp_' + 'b'.repeat(36);
const HOST_INJECTED = 'ghu_' + 'c'.repeat(36);

let saved: {
  token: string; repo: string; base: string;
  id: string; key: string; inst: string;
};

before(() => {
  saved = {
    token: config.githubToken,
    repo: config.githubRepo,
    base: config.githubApiBaseUrl,
    id: config.githubAppId,
    key: config.githubAppPrivateKey,
    inst: config.githubAppInstallationId,
  };
});

after(() => {
  config.githubToken = saved.token;
  config.githubRepo = saved.repo;
  config.githubApiBaseUrl = saved.base;
  config.githubAppId = saved.id;
  config.githubAppPrivateKey = saved.key;
  config.githubAppInstallationId = saved.inst;
});

beforeEach(() => {
  config.githubToken = '';
  config.githubRepo = '';
  config.githubAppId = '';
  config.githubAppPrivateKey = '';
  config.githubAppInstallationId = '';
});

// -------------------------------------------------------------- credential shapes
test('the credential kind is recognised without revealing any of it', () => {
  assert.equal(tokenKindOf(FINE_GRAINED), 'fine-grained-pat');
  assert.equal(tokenKindOf(CLASSIC), 'classic-pat');
  assert.equal(tokenKindOf(HOST_INJECTED), 'app-or-oauth-token');
  assert.equal(tokenKindOf('not-a-token'), 'unknown');
  for (const kind of [tokenKindOf(FINE_GRAINED), tokenKindOf(CLASSIC)]) {
    assert.ok(!kind.includes(FINE_GRAINED) && kind.length < 20, 'the kind must describe, not echo');
  }
});

test('a malformed credential is rejected before it can be stored', () => {
  assert.ok(validateTokenShape('short'), 'too short must be rejected');
  assert.ok(validateTokenShape(`${CLASSIC} extra`), 'whitespace must be rejected');
  assert.ok(validateTokenShape('AKIAIOSFODNN7EXAMPLE0000'), 'a non-GitHub shape must be rejected');
  assert.equal(validateTokenShape(FINE_GRAINED), null);
  assert.equal(validateTokenShape(`  ${CLASSIC}  `), null, 'surrounding whitespace is trimmed, not fatal');
});

// ------------------------------------------------------------------- precedence
test('a host-injected GITHUB_TOKEN is never consulted', () => {
  // The runtime variable is deliberately not part of config, so the only way a
  // ghu_ value could be picked up is if some code read process.env.GITHUB_TOKEN.
  // Setting it here proves the resolution path ignores it.
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = HOST_INJECTED;
  try {
    assert.equal(resolvedToken().source, 'none');
    assert.equal(credentialKind(), 'none');
    assert.equal(credentialInfo().configured, false);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test('a configured GitHub App outranks the environment token, matching the builds contract', () => {
  config.githubToken = CLASSIC;
  config.githubAppId = '12345';
  config.githubAppPrivateKey = '-----BEGIN RSA PRIVATE KEY-----fake';
  config.githubAppInstallationId = '67890';
  assert.equal(credentialKind(), 'app');
  assert.equal(resolvedToken().source, 'app', 'the App must win so githubBuilds mints an installation token');
  assert.equal(credentialInfo().tokenKind, 'github-app');
});

test('the environment token is used when no App is complete', () => {
  config.githubToken = CLASSIC;
  config.githubAppId = '12345';
  // Two of the three App values is not a usable App.
  assert.equal(credentialKind(), 'token');
  assert.equal(resolvedToken().source, 'env');
  assert.equal(credentialInfo().fingerprint, fingerprintOf(CLASSIC));
});

test('with nothing configured the state is none rather than a guess', () => {
  assert.equal(credentialKind(), 'none');
  assert.equal(resolvedToken().source, 'none');
  assert.equal(credentialInfo().configured, false);
});

// ------------------------------------------------------------------ redaction
test('a credential of any recognised shape is removed from log text', () => {
  for (const token of [FINE_GRAINED, CLASSIC, HOST_INJECTED]) {
    const line = `authorization: Bearer ${token} done`;
    const out = redact(line);
    assert.ok(!out.includes(token), 'the credential must not survive redaction');
    assert.ok(out.includes('[REDACTED]'));
  }
});

test('a credential named in a configuration string is redacted', () => {
  const out = redact(`MY_AI_STUDIO_GITHUB_TOKEN=${FINE_GRAINED}`);
  assert.ok(!out.includes(FINE_GRAINED));
  assert.ok(out.includes('MY_AI_STUDIO_GITHUB_TOKEN'));
});

test('the fingerprint identifies a credential without containing it', () => {
  const fp = fingerprintOf(FINE_GRAINED);
  assert.equal(fp.length, 16);
  assert.ok(!FINE_GRAINED.includes(fp));
  assert.equal(fp, fingerprintOf(FINE_GRAINED), 'the fingerprint is stable');
  assert.notEqual(fp, fingerprintOf(CLASSIC), 'different credentials have different fingerprints');
});

test('matchesStored compares by fingerprint and is false with nothing stored', () => {
  assert.equal(matchesStored(FINE_GRAINED), false, 'no stored credential means no match');
});

// --------------------------------------------------------- real HTTP verification
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; requests: string[] }> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test('a valid credential is verified and its write capability is observed', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/user') {
      res.writeHead(200, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo' });
      res.end(JSON.stringify({ login: 'octocat' }));
      return;
    }
    if (req.url === '/repos/owner/app' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ full_name: 'owner/app', default_branch: 'main' }));
      return;
    }
    if (req.url === '/repos/owner/app/git/blobs') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha: 'deadbeef' }));
      return;
    }
    if (req.url === '/repos/owner/app/actions/workflows/android-build.yml/dispatches') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  config.githubApiBaseUrl = server.url;
  try {
    const probe = await probeCredential(FINE_GRAINED, 'owner/app');
    assert.equal(probe.ok, true);
    assert.equal(probe.login, 'octocat');
    assert.equal(probe.canRead, true);
    assert.equal(probe.canWrite, true);
    assert.equal(probe.actions, true);
    assert.equal(probe.error, null);
    assert.ok(
      server.requests.includes('POST /repos/owner/app/actions/workflows/android-build.yml/dispatches'),
      'the dispatch probe must be a real request',
    );
  } finally {
    await server.close();
    config.githubApiBaseUrl = saved.base;
  }
});

test('a rejected credential is reported as rejected rather than throwing', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Bad credentials' }));
  });
  config.githubApiBaseUrl = server.url;
  try {
    const probe = await probeCredential(CLASSIC, 'owner/app');
    assert.equal(probe.ok, false);
    assert.equal(probe.canRead, false);
    assert.match(probe.error ?? '', /401/);
  } finally {
    await server.close();
    config.githubApiBaseUrl = saved.base;
  }
});

test('a read-only credential is distinguished from a writable one', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/user') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ login: 'readonly' }));
      return;
    }
    if (req.url === '/repos/owner/app' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ full_name: 'owner/app' }));
      return;
    }
    // A write to the repository is refused, but dispatching is allowed.
    if (req.url === '/repos/owner/app/git/blobs') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url?.endsWith('/dispatches')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  config.githubApiBaseUrl = server.url;
  try {
    const probe = await probeCredential(CLASSIC, 'owner/app');
    assert.equal(probe.canRead, true);
    assert.equal(probe.canWrite, false, 'a 403 on the blob write must read as read-only');
    assert.equal(probe.actions, true);
  } finally {
    await server.close();
    config.githubApiBaseUrl = saved.base;
  }
});

test('an unreachable GitHub is reported as an error, and the token never appears in it', async () => {
  // Port 1 on loopback refuses immediately, so this exercises the transport
  // failure branch without reaching any network.
  config.githubApiBaseUrl = 'http://127.0.0.1:1';
  try {
    const probe = await probeCredential(FINE_GRAINED, 'owner/app');
    assert.equal(probe.ok, false);
    assert.ok(probe.error, 'a transport failure must produce a message');
    assert.ok(!probe.error.includes(FINE_GRAINED), 'the credential must not leak into the error');
  } finally {
    config.githubApiBaseUrl = saved.base;
  }
});

// ------------------------------------------------------------------ status shape
test('the status reports the credential source without exposing the credential', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/repos/owner/app' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ full_name: 'owner/app', default_branch: 'main' }));
      return;
    }
    if (req.url === '/repos/owner/app/actions/runs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ workflow_runs: [] }));
      return;
    }
    if (req.url === '/repos/owner/app/git/blobs') {
      res.writeHead(201);
      res.end('{}');
      return;
    }
    if (req.url?.endsWith('/dispatches')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  config.githubApiBaseUrl = server.url;
  config.githubToken = CLASSIC;
  config.githubRepo = 'owner/app';
  try {
    const status = await getGithubStatus();
    assert.equal(status.credentialSource, 'env');
    assert.equal(status.canWrite, true);
    assert.equal(status.canRead, true);
    assert.equal(status.repository, 'owner/app');
    const text = JSON.stringify(status);
    assert.ok(!text.includes(CLASSIC), 'no status field may carry the credential');
    assert.ok(!text.includes(fingerprintOf(CLASSIC)), 'the fingerprint is not part of the status contract');
  } finally {
    await server.close();
    config.githubApiBaseUrl = saved.base;
  }
});
