import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { dispatchWorkflow, getGithubStatus } from '../src/services/githubActions.ts';
import { syncWorkspaceToRepo } from '../src/services/githubSync.ts';
import { config } from '../src/config/index.ts';

/**
 * A read-only credential is the failure mode that matters here: it passes every
 * read, so the integration looks healthy, and only fails at the first write.
 * These tests drive a real HTTP server so the 403 path is exercised as bytes
 * over a socket, and they assert on what the operator is told, because the fix
 * (grant Contents: write and Actions: write) is not in GitHub's own message.
 */

let server: http.Server;
let apiBase = '';
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

before(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  apiBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const saved = {
  apiBaseUrl: config.githubApiBaseUrl,
  repo: config.githubRepo,
  token: config.githubToken,
  workflow: config.githubWorkflow,
};

beforeEach(() => {
  config.githubApiBaseUrl = apiBase;
  config.githubRepo = 'owner/name';
  config.githubToken = 'ghu_readonly_token_value';
  config.githubWorkflow = 'android-build.yml';
});

after(() => {
  config.githubApiBaseUrl = saved.apiBaseUrl;
  config.githubRepo = saved.repo;
  config.githubToken = saved.token;
  config.githubWorkflow = saved.workflow;
});

const FORBIDDEN = {
  message: 'Resource not accessible by integration',
  documentation_url: 'https://docs.github.com/rest/git/blobs#create-a-blob',
  status: '403',
};

test('a refused dispatch explains the permission that is actually missing', async () => {
  handler = (_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(FORBIDDEN));
  };
  const result = await dispatchWorkflow({ repo: 'owner/name', workflow: 'android-build.yml', ref: 'my-ai-studio-build' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  // GitHub's message alone names no permission and no remedy.
  assert.match(result.error ?? '', /Contents: write and Actions: write/);
  assert.match(result.error ?? '', /token/i);
});

test('the permission hint is only added for an authorization refusal', async () => {
  handler = (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Server Error' }));
  };
  const result = await dispatchWorkflow({ repo: 'owner/name', workflow: 'android-build.yml', ref: 'my-ai-studio-build' });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error ?? '', /Contents: write/);
});

test('a read-only credential is reported as unable to write, not as healthy', async () => {
  handler = (req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.includes('/git/blobs')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FORBIDDEN));
      return;
    }
    if (url.includes('/actions/runs')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_count: 0, workflow_runs: [] }));
      return;
    }
    if (url.includes('/actions/workflows')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total_count: 0, workflows: [] }));
      return;
    }
    // The repository itself reads fine, which is exactly the trap.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ full_name: 'owner/name', default_branch: 'main' }));
  };
  const status = await getGithubStatus();
  assert.equal(status.state, 'AVAILABLE');
  assert.equal(status.connected, true);
  assert.equal(status.canWrite, false);
  assert.match(status.detail ?? '', /cannot write/);
});

test('the status payload never contains the token, even after a refused write', async () => {
  handler = (req, res) => {
    if (req.method === 'POST') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FORBIDDEN));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ full_name: 'owner/name', default_branch: 'main', total_count: 0, workflow_runs: [], workflows: [] }));
  };
  const status = await getGithubStatus();
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('ghu_readonly_token_value'));
  assert.ok(!/ghu_|ghp_|github_pat_|ghs_/.test(serialized));
  assert.equal(status.tokenConfigured, true);
});

test('publishing to a repository the credential cannot write fails instead of claiming a commit', async () => {
  handler = (req, res) => {
    const url = req.url ?? '';
    if (req.method === 'POST' && url.includes('/git/blobs')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(FORBIDDEN));
      return;
    }
    // Existing branch reads succeed, so the sync gets as far as the write.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: { sha: 'a'.repeat(40) }, tree: { sha: 'b'.repeat(40) }, sha: 'b'.repeat(40), truncated: false, default_branch: 'main' }));
  };
  // A workspace with one file, so the walk has something to publish.
  const projectId = `sync-${process.pid}-${Date.now()}`;
  const { WorkspaceService } = await import('../src/services/workspace.ts');
  const ws = new WorkspaceService(projectId);
  await ws.ensure();
  await ws.write('Main.kt', 'fun main() {}\n');

  const result = await syncWorkspaceToRepo({ projectId, repo: 'owner/name' });
  assert.equal(result.ok, false);
  assert.equal(result.commitSha, null);
  assert.match(result.error ?? '', /blob creation failed|Contents: write/);

  const { rm } = await import('node:fs/promises');
  await rm(ws.root, { recursive: true, force: true });
});
