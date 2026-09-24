import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getGithubStatus, downloadArtifact } from '../src/services/githubActions.ts';
import { config } from '../src/config/index.ts';
import { redact } from '../src/lib/logger.ts';

/**
 * The GitHub integration is exercised against a real local HTTP server so the
 * state machine (NOT_CONFIGURED -> ERROR -> AVAILABLE) is verified against
 * actual socket traffic rather than a stubbed fetch. `config` is captured at
 * import time, so it is mutated in place here, as the OpenRouter tests do.
 */
type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let apiBase = '';
let respond: Responder;
let requests: string[] = [];
let authHeader: string | undefined;

before(async () => {
  server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    authHeader = req.headers.authorization;
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  apiBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests = [];
  authHeader = undefined;
  config.githubApiBaseUrl = apiBase;
  config.githubToken = '';
  config.githubRepo = '';
});

const json = (res: http.ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

test('without a repo the status is NOT_CONFIGURED and no request is made', async () => {
  respond = (_req, res) => json(res, 200, {});
  const status = await getGithubStatus();

  assert.equal(status.state, 'NOT_CONFIGURED');
  assert.equal(status.connected, false);
  assert.match(status.detail ?? '', /GITHUB_REPO/);
  assert.equal(requests.length, 0, 'an unconfigured integration must not call GitHub');
});

test('a public repository is probed without a token and reports AVAILABLE', async () => {
  config.githubRepo = 'acme/studio';
  respond = (req, res) => {
    if (req.url === '/repos/acme/studio') {
      json(res, 200, { full_name: 'acme/studio', default_branch: 'main' });
      return;
    }
    json(res, 200, { workflow_runs: [] });
  };
  const status = await getGithubStatus();

  assert.equal(status.state, 'AVAILABLE');
  assert.equal(status.connected, true);
  assert.equal(status.tokenConfigured, false);
  assert.equal(authHeader, undefined, 'no Authorization header is sent when no token is set');
  assert.equal(requests.length, 2);
});

test('a bad credential is ERROR, never AVAILABLE', async () => {
  config.githubToken = 'ghp_' + 'b'.repeat(36);
  config.githubRepo = 'acme/studio';
  respond = (_req, res) => json(res, 401, { message: 'Bad credentials' });
  const status = await getGithubStatus();

  assert.equal(status.state, 'ERROR');
  assert.equal(status.connected, false);
  assert.match(status.detail ?? '', /401/);
  assert.equal(requests.length, 1, 'a configured integration really does call GitHub');
});

test('a reachable repository is AVAILABLE and reports the real latest run and artifacts', async () => {
  config.githubToken = 'ghp_' + 'c'.repeat(36);
  config.githubRepo = 'acme/studio';
  respond = (req, res) => {
    if (req.url === '/repos/acme/studio') {
      json(res, 200, { full_name: 'acme/studio', default_branch: 'main' });
      return;
    }
    if (req.url?.startsWith('/repos/acme/studio/actions/runs?')) {
      json(res, 200, {
        workflow_runs: [
          {
            id: 42, name: 'build-apk', workflow_name: 'build-apk', run_number: 7,
            status: 'completed', conclusion: 'success', head_branch: 'main',
            head_sha: 'a'.repeat(40), event: 'workflow_dispatch',
            created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:05:00Z',
            html_url: 'https://example.invalid/acme/studio/actions/runs/42',
          },
        ],
      });
      return;
    }
    if (req.url === '/repos/acme/studio/actions/runs/42/artifacts') {
      json(res, 200, {
        artifacts: [
          { id: 99, name: 'my-ai-studio-debug-apk', size_in_bytes: 3195645, expired: false, created_at: '2026-01-01T00:04:00Z', archive_download_url: 'https://example.invalid/dl' },
        ],
      });
      return;
    }
    json(res, 404, { message: 'Not Found' });
  };

  const status = await getGithubStatus();

  assert.equal(status.state, 'AVAILABLE');
  assert.equal(status.connected, true);
  assert.equal(status.latestRun?.id, 42);
  assert.equal(status.latestRun?.conclusion, 'success');
  assert.equal(status.latestRun?.runNumber, 7);
  assert.equal(status.latestArtifacts.length, 1);
  assert.equal(status.latestArtifacts[0].name, 'my-ai-studio-debug-apk');
  assert.equal(status.latestArtifacts[0].sizeInBytes, 3195645);
  assert.equal(authHeader, `Bearer ${config.githubToken}`, 'the token is sent as a bearer header');
});

test('a network failure is ERROR rather than a crash or a fabricated success', async () => {
  config.githubToken = 'ghp_' + 'd'.repeat(36);
  config.githubRepo = 'acme/studio';
  // Point at a closed port: the real transport fails and must be mapped.
  const dead = http.createServer();
  await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
  const addr = dead.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise<void>((resolve) => dead.close(() => resolve()));
  config.githubApiBaseUrl = `http://127.0.0.1:${port}`;

  const status = await getGithubStatus();

  assert.equal(status.state, 'ERROR');
  assert.equal(status.connected, false);
  assert.ok(status.detail && status.detail.length > 0);
});

test('the token never appears in the status payload', async () => {
  const token = 'ghp_' + 'e'.repeat(36);
  config.githubToken = token;
  config.githubRepo = 'acme/studio';
  respond = (req, res) => {
    if (req.url === '/repos/acme/studio') {
      json(res, 200, { full_name: 'acme/studio', default_branch: 'main' });
      return;
    }
    json(res, 200, { workflow_runs: [] });
  };

  const status = await getGithubStatus();
  const serialised = JSON.stringify(status);

  assert.ok(!serialised.includes(token), 'the raw token is absent from the payload');
  assert.ok(!/ghp_[A-Za-z0-9]{20,}/.test(serialised), 'no token shape appears');
  assert.equal(status.tokenConfigured, true, 'presence is reported without the value');
});

test('redact masks GitHub token shapes and the configured token value', () => {
  const token = 'ghp_' + 'f'.repeat(36);
  config.githubToken = token;

  assert.ok(!redact(`Authorization: Bearer ${token}`).includes(token));
  assert.ok(!redact('GITHUB_TOKEN=' + token).includes(token));
  assert.equal(redact(token), '[REDACTED]');
  // A fine-grained token is masked by shape alone, without being configured.
  const fine = 'github_pat_' + 'A'.repeat(30);
  assert.ok(!redact(`x ${fine} y`).includes(fine));
});

test('downloadArtifact refuses without a token and streams bytes when authorized', async () => {
  // Without a token the function must decline rather than fetch anonymously:
  // action artifact downloads always require authentication.
  config.githubToken = '';
  const refused = await downloadArtifact('acme/studio', 7);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 503);
  assert.equal(requests.length, 0);

  config.githubToken = 'ghp_' + 'a'.repeat(36);
  const payload = Buffer.from('PK\u0003\u0004 pretend zip bytes');
  respond = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(payload);
  };

  const result = await downloadArtifact('acme/studio', 7);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.contentType, 'application/zip');
  assert.ok(result.body, 'a body stream is returned');

  const reader = result.body!.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  assert.equal(Buffer.concat(chunks).toString(), payload.toString(), 'the streamed bytes match what GitHub sent');
  assert.equal(authHeader, `Bearer ${config.githubToken}`, 'the download is authenticated server-side');
});

test('downloadArtifact maps a non-200 from GitHub to a failure, not a fake success', async () => {
  config.githubToken = 'ghp_' + 'b'.repeat(36);
  respond = (_req, res) => json(res, 404, { message: 'Not Found' });

  const result = await downloadArtifact('acme/studio', 7);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.body, null);
});
