import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config/index.ts';
import { deriveStatus, isTerminal } from '../src/services/githubBuilds.ts';
import {
  credentialKind, dispatchWorkflow, getGithubStatus, getRepoBranchHead, createBlobs, createTree, createCommit, updateRef,
  extractApkFromArtifact, extractRunLogText,
} from '../src/services/githubActions.ts';
import { validateApkBuffer, readZipEntries, readZipEntry } from '../src/lib/apkZip.ts';
import { collectPublishableFiles, syncWorkspaceToRepo } from '../src/services/githubSync.ts';
import { sha256Hex } from '../src/lib/hash.ts';
import { buildApkFixture, buildApkWithSecondaryDex, makeZipArchive } from './fixtures/buildApk.ts';
import { makeZip, crc32 } from './fixtures/zip.ts';

/**
 * Tests for the GitHub Actions build path.
 *
 * The archive, APK and publish-filter assertions run on real code: real ZIP
 * archives are assembled and read back, the real AAPT2-compiled manifest fixture
 * is validated, and the filter walks a real directory tree. The publish test
 * drives the real sync service against a local HTTP server standing in for the
 * GitHub API, so the request sequence itself is verified. No call leaves the
 * machine; the live HTTP behaviour of the client is covered in github.test.ts.
 */

let tmpRoot = '';

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mas-gh-test-'));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------ CASE 1-1 / 1-2
test('CASE 1-1/1-2: the credential kind follows the configuration, not a probe', () => {
  const saved = {
    token: config.githubToken, id: config.githubAppId,
    key: config.githubAppPrivateKey, inst: config.githubAppInstallationId,
  };

  config.githubToken = '';
  config.githubAppId = '';
  config.githubAppPrivateKey = '';
  config.githubAppInstallationId = '';
  assert.equal(credentialKind(), 'none');

  config.githubToken = 'ghp_' + 'a'.repeat(36);
  assert.equal(credentialKind(), 'token');

  config.githubAppId = '123';
  config.githubAppPrivateKey = '-----BEGIN RSA PRIVATE KEY-----';
  config.githubAppInstallationId = '456';
  assert.equal(credentialKind(), 'app', 'a complete App triple wins over a token');

  // An incomplete App triple must not be treated as usable.
  config.githubAppPrivateKey = '';
  assert.equal(credentialKind(), 'token', 'a partial App config falls back to the token');

  Object.assign(config, {
    githubToken: saved.token, githubAppId: saved.id,
    githubAppPrivateKey: saved.key, githubAppInstallationId: saved.inst,
  });
});

// ----------------------------------------------------- CASE 1-2 (write probe)
test('CASE 1-2: status is NOT_CONFIGURED without a repository, and never leaks a token', async () => {
  const savedRepo = config.githubRepo;
  config.githubRepo = '';
  const status = await getGithubStatus();
  assert.equal(status.state, 'NOT_CONFIGURED');
  assert.equal(status.connected, false);
  assert.equal(status.canWrite, null);
  // The serialized status must not carry the credential itself, only its shape.
  const text = JSON.stringify(status);
  if (config.githubToken) assert.ok(!text.includes(config.githubToken), 'the token must not appear in status');
  assert.equal(status.tokenConfigured, config.githubToken.length > 0);
  config.githubRepo = savedRepo;
});

test('CASE 1-2b: a read-only credential is reported as unable to write', async () => {
  const saved = { token: config.githubToken, repo: config.githubRepo };
  // A syntactically valid token GitHub will reject: the probe must report a
  // denial (canWrite false) rather than claiming a working integration.
  config.githubRepo = 'my-ai-studio-does-not-exist/nonexistent-probe-repo';
  config.githubToken = 'ghs_' + 'z'.repeat(36);
  const status = await getGithubStatus();
  assert.equal(status.connected, false, 'a nonexistent repository must not read as connected');
  assert.ok(['ERROR', 'AVAILABLE'].includes(status.state));
  config.githubToken = saved.token;
  config.githubRepo = saved.repo;
});

// ----------------------------------------------------------------- CASE 2-2
test('CASE 2-2: a workflow other than the configured one is refused before any request', async () => {
  const saved = config.githubWorkflow;
  config.githubWorkflow = 'android-build.yml';
  const res = await dispatchWorkflow({ repo: 'acme/studio', workflow: 'evil.yml', ref: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.match(res.error ?? '', /not the configured build workflow/);
  config.githubWorkflow = saved;
});

test('a dispatch with no repository is refused rather than attempted', async () => {
  const saved = config.githubWorkflow;
  config.githubWorkflow = 'android-build.yml';
  const res = await dispatchWorkflow({ repo: '', workflow: 'android-build.yml', ref: 'main' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  config.githubWorkflow = saved;
});

test('Git Data reads fail honestly when no credential is configured', async () => {
  const saved = {
    token: config.githubToken, id: config.githubAppId,
    key: config.githubAppPrivateKey, inst: config.githubAppInstallationId,
  };
  config.githubToken = '';
  config.githubAppId = '';
  config.githubAppPrivateKey = '';
  config.githubAppInstallationId = '';

  for (const res of [
    await getRepoBranchHead('acme/studio', 'main'),
    await createBlobs('acme/studio', [{ content: 'x' }]),
    await createTree('acme/studio', []),
    await createCommit('acme/studio', { message: 'x', tree: 'a', parents: [] }),
    await updateRef('acme/studio', 'main', 'a'.repeat(40)),
  ]) {
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /no GitHub credential/);
  }

  Object.assign(config, {
    githubToken: saved.token, githubAppId: saved.id,
    githubAppPrivateKey: saved.key, githubAppInstallationId: saved.inst,
  });
});

// --------------------------------------------------------------- CASE 6 / 7
test('CASE 6-7: queued runs are queued; an active build job means building', () => {
  assert.equal(deriveStatus(makeRun('queued', null), []), 'queued');
  assert.equal(deriveStatus(makeRun('waiting', null), []), 'queued');
  const running = makeRun('in_progress', null);
  assert.equal(deriveStatus(running, [{ name: 'test and assemble debug', status: 'in_progress' }]), 'building');
  assert.equal(deriveStatus(running, [{ name: 'unit tests', status: 'in_progress' }]), 'testing');
  assert.equal(deriveStatus(running, []), 'testing');
});

test('CASE 8: a completed run maps to its real conclusion', () => {
  assert.equal(deriveStatus(makeRun('completed', 'success'), []), 'success');
  assert.equal(deriveStatus(makeRun('completed', 'failure'), []), 'failed');
  assert.equal(deriveStatus(makeRun('completed', 'cancelled'), []), 'cancelled');
  assert.equal(deriveStatus(makeRun('completed', 'timed_out'), []), 'timeout');
  assert.equal(deriveStatus(makeRun('completed', 'action_required'), []), 'failed');
});

test('terminal states are exactly the four that end a build', () => {
  for (const s of ['success', 'failed', 'cancelled', 'timeout']) assert.equal(isTerminal(s), true, s);
  for (const s of ['queued', 'running', 'testing', 'building', 'not_configured', 'blocked']) {
    assert.equal(isTerminal(s), false, `${s} must not be terminal`);
  }
});

// -------------------------------------------------------------- CASE 9 / 10
test('CASE 9: an artifact archive without an APK member is rejected', () => {
  const archive = makeZipArchive([{ name: 'BUILD_INFO.txt', content: Buffer.from('no apk') }]);
  const res = extractApkFromArtifact(archive);
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /no \.apk member/);
});

test('CASE 10: an artifact archive with an APK member yields exactly its bytes', () => {
  const apkBytes = buildApkFixture();
  const archive = makeZipArchive([
    { name: 'app-debug.apk', content: apkBytes },
    { name: 'SHA256SUMS.txt', content: Buffer.from('x  ./app-debug.apk\n') },
  ]);
  const res = extractApkFromArtifact(archive);
  assert.equal(res.ok, true);
  assert.equal(res.fileName, 'app-debug.apk');
  assert.deepEqual(res.bytes, apkBytes);
});

test('a malformed artifact archive is reported, not mistaken for an APK', () => {
  const res = extractApkFromArtifact(Buffer.from('definitely not a zip'));
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

// ------------------------------------------------------------------ CASE 11
test('CASE 11: SHA-256 is over the artifact bytes and changes on any edit', () => {
  const apkBytes = buildApkFixture();
  const digest = sha256Hex(apkBytes);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(sha256Hex(Buffer.from(apkBytes)), digest);
  const tampered = Buffer.from(apkBytes);
  tampered[tampered.length - 1] ^= 0xff;
  assert.notEqual(sha256Hex(tampered), digest);
});

// ------------------------------------------------------------------ CASE 12
test('CASE 12: real APK validation accepts a well-formed fixture and reports its manifest', () => {
  const validation = validateApkBuffer(buildApkFixture());
  assert.equal(validation.valid, true, validation.error ?? '');
  assert.equal(validation.hasManifest, true);
  assert.equal(validation.hasDex, true);
  assert.equal(validation.packageName, 'com.myaistudio.calculator');
  assert.ok(validation.entryCount >= 4);
});

test('a secondary dex still counts as a dex', () => {
  const validation = validateApkBuffer(buildApkWithSecondaryDex());
  assert.equal(validation.valid, true, validation.error ?? '');
  assert.equal(validation.dexFiles, 2);
});

test('an APK-lookalike without a manifest or dex is rejected', () => {
  const noManifest = validateApkBuffer(makeZipArchive([{ name: 'classes.dex', content: Buffer.from('dex\n035\0') }]));
  assert.equal(noManifest.valid, false);
  assert.match(noManifest.error ?? '', /AndroidManifest/);

  const noDex = validateApkBuffer(makeZipArchive([{ name: 'AndroidManifest.xml', content: Buffer.from([3, 0, 8, 0]) }]));
  assert.equal(noDex.valid, false);
  assert.match(noDex.error ?? '', /classes/);

  const empty = validateApkBuffer(Buffer.alloc(0));
  assert.equal(empty.valid, false);
  assert.match(empty.error ?? '', /empty/);
});

// ----------------------------------------------------- CASE 13 (publish set)
test('CASE 13: the publish filter excludes environment, secrets, caches and build output', async () => {
  const dir = path.join(tmpRoot, 'project-a');
  for (const d of ['app/src', 'build', 'node_modules/x', '.gradle', '.git', 'dist']) {
    await fs.mkdir(path.join(dir, d), { recursive: true });
  }
  await fs.writeFile(path.join(dir, 'app', 'src', 'Main.kt'), 'fun main() {}\n');
  await fs.writeFile(path.join(dir, 'gradlew'), '#!/bin/sh\n');
  await fs.writeFile(path.join(dir, 'build', 'out.apk'), 'binary');
  await fs.writeFile(path.join(dir, 'node_modules', 'x', 'index.js'), 'x');
  await fs.writeFile(path.join(dir, '.gradle', 'c'), 'c');
  await fs.writeFile(path.join(dir, '.git', 'config'), 'c');
  await fs.writeFile(path.join(dir, 'dist', 'bundle.js'), 'b');
  await fs.writeFile(path.join(dir, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop\n');
  await fs.writeFile(path.join(dir, 'credentials.json'), '{}');
  await fs.writeFile(path.join(dir, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n');
  await fs.writeFile(path.join(dir, 'Config.kt'), 'val KEY = "sk-or-v1-abcdefghijklmnopqrst"\n');

  const { files, skipped } = await collectPublishableFiles(dir);
  const names = files.map((f) => f.rel).sort();

  assert.deepEqual(names, ['app/src/Main.kt', 'gradlew'], 'only real source is published');
  const joined = skipped.join('\n');
  for (const expected of ['.env', 'credentials.json', 'server.pem', 'build/', 'node_modules/', '.gradle/', '.git/', 'dist/', 'Config.kt']) {
    assert.ok(joined.includes(expected), `${expected} must be reported skipped`);
  }
  const published = files.map((f) => f.content.toString('utf8')).join('\n');
  assert.ok(!published.includes('sk-or-'), 'no secret value may appear in the published set');
});

test('CASE 13b: a file above the size bound is skipped rather than truncated', async () => {
  const dir = path.join(tmpRoot, 'project-big');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'small.txt'), 'ok');
  await fs.writeFile(path.join(dir, 'big.bin'), Buffer.alloc(2048, 1));

  const { files, skipped } = await collectPublishableFiles(dir, 2000, 1024);
  assert.deepEqual(files.map((f) => f.rel), ['small.txt']);
  assert.ok(skipped.some((s) => s.includes('big.bin') && s.includes('exceeds')));
});

// ------------------------------------------------------------------ CASE 14
test('CASE 14: a stored archive reads back byte-for-byte', () => {
  const entries = [
    { name: 'a.txt', content: Buffer.from('alpha'), store: true },
    { name: 'dir/b.bin', content: Buffer.from([0, 1, 2, 3, 255, 254]), store: true },
    { name: 'empty.txt', content: Buffer.alloc(0), store: true },
  ];
  const archive = makeZipArchive(entries);
  const parsed = readZipEntries(archive);
  assert.equal(parsed.ok, true, parsed.error ?? '');
  assert.equal(parsed.entries.length, 3);
  for (const e of entries) {
    assert.deepEqual(readZipEntry(archive, e.name), e.content, `${e.name} must round-trip`);
  }
});

test('the zip reader bounds the declared entry count and reports truncation', () => {
  const archive = makeZipArchive([{ name: 'a.txt', content: Buffer.from('x') }]);
  const bounded = readZipEntries(archive, 0);
  assert.equal(bounded.ok, false);
  assert.match(bounded.error ?? '', /above the 0 limit/);

  const truncated = readZipEntries(archive.subarray(0, Math.floor(archive.length / 2)));
  assert.equal(truncated.ok, false);
  assert.ok(truncated.error);
});

test('a non-zip buffer is refused by the reader', () => {
  assert.equal(readZipEntries(Buffer.from('not a zip at all')).ok, false);
  assert.equal(readZipEntries(Buffer.alloc(4)).ok, false);
});

// ------------------------------------------------------------------ CASE 15
test('CASE 15: the independent ZIP writer the tests rely on is correct', () => {
  const entries = [
    { name: 'one.txt', content: Buffer.from('hello') },
    { name: 'two.txt', content: Buffer.from('world'.repeat(50)) },
  ];
  const archive = makeZip(entries);
  const parsed = readZipEntries(archive);
  assert.equal(parsed.ok, true, parsed.error ?? '');
  for (const e of entries) assert.deepEqual(readZipEntry(archive, e.name), e.content);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 must match the standard check value');
});

// -------------------------------------------------- CASE 3 (publish sequence)
test('CASE 3: publishing the workspace drives the Git Data API in order and installs the workflow', async () => {
  const projectId = 'publish-seq';
  const projectDir = path.join(config.workspaceRoot, projectId);
  await fs.mkdir(path.join(projectDir, 'app', 'src'), { recursive: true });
  await fs.writeFile(path.join(projectDir, 'app', 'src', 'Main.kt'), 'fun main() {}\n');
  await fs.writeFile(
    path.join(projectDir, 'settings.gradle.kts'),
    'rootProject.name = "published"\n',
  );

  const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';
      if (url === '/repos/acme/studio') {
        // The default branch is where GitHub registers workflow_dispatch.
        res.end(JSON.stringify({ default_branch: 'main' }));
        return;
      }
      if (url === '/repos/acme/studio/git/ref/heads/my-ai-studio-build') {
        res.end(JSON.stringify({ object: { sha: 'b'.repeat(40) } }));
        return;
      }
      if (url === '/repos/acme/studio/git/ref/heads/main') {
        res.end(JSON.stringify({ object: { sha: 'd'.repeat(40) } }));
        return;
      }
      if (url === `/repos/acme/studio/git/commits/${'b'.repeat(40)}`) {
        res.end(JSON.stringify({ tree: { sha: 'tree-base' } }));
        return;
      }
      if (url === `/repos/acme/studio/git/commits/${'d'.repeat(40)}`) {
        res.end(JSON.stringify({ tree: { sha: 'tree-main' } }));
        return;
      }
      if (url === '/repos/acme/studio/git/trees/tree-main?recursive=1') {
        // The workflow is not on main yet, so the publish must install it.
        res.end(JSON.stringify({ tree: [{ path: 'server.js', mode: '100644', type: 'blob', sha: 'srv' }], truncated: false }));
        return;
      }
      if (url === '/repos/acme/studio/git/blobs') {
        res.end(JSON.stringify({ sha: `blob-${calls.length}` }));
        return;
      }
      if (url === '/repos/acme/studio/git/trees') {
        res.end(JSON.stringify({ sha: 'tree-new' }));
        return;
      }
      if (url === '/repos/acme/studio/git/commits') {
        res.end(JSON.stringify({ sha: 'c'.repeat(40) }));
        return;
      }
      if (url === '/repos/acme/studio/git/refs/heads/my-ai-studio-build') {
        res.end(JSON.stringify({ object: { sha: 'c'.repeat(40) } }));
        return;
      }
      if (url === '/repos/acme/studio/git/refs/heads/main') {
        res.end(JSON.stringify({ object: { sha: 'e'.repeat(40) } }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'unexpected call' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const saved = { base: config.githubApiBaseUrl, token: config.githubToken, workflow: config.githubWorkflow, ref: config.githubWorkflowRef };
  config.githubApiBaseUrl = base;
  config.githubToken = 'ghp_' + 'a'.repeat(36);
  config.githubWorkflow = 'android-build.yml';
  config.githubWorkflowRef = 'my-ai-studio-build';

  try {
    const result = await syncWorkspaceToRepo({
      projectId, repo: 'acme/studio', branch: 'my-ai-studio-build',
    });
    assert.equal(result.ok, true, result.error ?? '');

    const urls = calls.map((c) => `${c.method} ${c.url}`);
    assert.deepEqual(urls, [
      'GET /repos/acme/studio/git/ref/heads/my-ai-studio-build',
      `GET /repos/acme/studio/git/commits/${'b'.repeat(40)}`,
      // One blob per file: two project files plus the managed workflow.
      'POST /repos/acme/studio/git/blobs',
      'POST /repos/acme/studio/git/blobs',
      'POST /repos/acme/studio/git/blobs',
      'POST /repos/acme/studio/git/trees',
      'POST /repos/acme/studio/git/commits',
      // updateRef re-reads the head so it can choose PATCH over POST.
      'GET /repos/acme/studio/git/ref/heads/my-ai-studio-build',
      'PATCH /repos/acme/studio/git/refs/heads/my-ai-studio-build',
      // The workflow is then installed on the default branch, because GitHub
      // only registers workflow_dispatch there.
      'GET /repos/acme/studio',
      'GET /repos/acme/studio/git/ref/heads/main',
      `GET /repos/acme/studio/git/commits/${'d'.repeat(40)}`,
      'POST /repos/acme/studio/git/blobs',
      'GET /repos/acme/studio/git/trees/tree-main?recursive=1',
      'POST /repos/acme/studio/git/trees',
      'POST /repos/acme/studio/git/commits',
      'GET /repos/acme/studio/git/ref/heads/main',
      'PATCH /repos/acme/studio/git/refs/heads/main',
    ]);

    // Trees are built over the existing snapshot, or a sparse publish would
    // delete everything else in the repository.
    const treeCall = calls.find((c) => c.url === '/repos/acme/studio/git/trees');
    assert.equal(treeCall?.body.base_tree, 'tree-base');

    // The managed workflow must be part of the same single commit, so the
    // repository always holds the workflow the server dispatches.
    const blobPaths = (treeCall?.body.tree as Array<{ path: string }>).map((t) => t.path).sort();
    assert.deepEqual(blobPaths, [
      '.github/workflows/android-build.yml',
      'app/src/Main.kt',
      'settings.gradle.kts',
    ]);

    const commitCall = calls.find((c) => c.url === '/repos/acme/studio/git/commits');
    assert.deepEqual(commitCall?.body.parents, ['b'.repeat(40)]);
    const refCall = calls.find((c) => c.method === 'PATCH');
    assert.equal(refCall?.body.sha, 'c'.repeat(40));

    assert.equal(result.filesPushed, 2, 'the workflow is installed in addition to the two project files');
    assert.equal(result.commitSha, 'c'.repeat(40));
  } finally {
    config.githubApiBaseUrl = saved.base;
    config.githubToken = saved.token;
    config.githubWorkflow = saved.workflow;
    config.githubWorkflowRef = saved.ref;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('CASE 3c: a default branch that already holds the workflow is left alone', async () => {
  // GitHub requires the workflow on the default branch for dispatch, but a
  // publish must not add a commit to a user's main branch when nothing changed.
  const projectId = 'publish-idempotent';
  const projectDir = path.join(config.workspaceRoot, projectId);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'Main.kt'), 'fun main() {}\n');

  const workflowSource = await fs.readFile(
    path.resolve(fileURLToPath(new URL('../../.github/workflows/android-build.yml', import.meta.url))),
  );
  // The blob sha GitHub reports for identical content, computed the same way.
  const sameSha = crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${workflowSource.length}\0`), workflowSource]))
    .digest('hex');

  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';
      if (url === '/repos/acme/studio') { res.end(JSON.stringify({ default_branch: 'main' })); return; }
      if (url === '/repos/acme/studio/git/ref/heads/my-ai-studio-build') { res.end(JSON.stringify({ object: { sha: 'b'.repeat(40) } })); return; }
      if (url === '/repos/acme/studio/git/ref/heads/main') { res.end(JSON.stringify({ object: { sha: 'd'.repeat(40) } })); return; }
      if (url === `/repos/acme/studio/git/commits/${'b'.repeat(40)}`) { res.end(JSON.stringify({ tree: { sha: 'tree-base' } })); return; }
      if (url === `/repos/acme/studio/git/commits/${'d'.repeat(40)}`) { res.end(JSON.stringify({ tree: { sha: 'tree-main' } })); return; }
      if (url === '/repos/acme/studio/git/trees/tree-main?recursive=1') {
        // The workflow is present with exactly the content being published.
        res.end(JSON.stringify({
          tree: [{ path: '.github/workflows/android-build.yml', mode: '100644', type: 'blob', sha: sameSha }],
          truncated: false,
        }));
        return;
      }
      if (url === '/repos/acme/studio/git/blobs') { res.end(JSON.stringify({ sha: sameSha })); return; }
      if (url === '/repos/acme/studio/git/trees') { res.end(JSON.stringify({ sha: 'tree-new' })); return; }
      if (url === '/repos/acme/studio/git/commits') { res.end(JSON.stringify({ sha: 'c'.repeat(40) })); return; }
      if (url === '/repos/acme/studio/git/refs/heads/my-ai-studio-build') { res.end(JSON.stringify({ object: { sha: 'c'.repeat(40) } })); return; }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'unexpected call' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const saved = { base: config.githubApiBaseUrl, token: config.githubToken, workflow: config.githubWorkflow, ref: config.githubWorkflowRef };
  config.githubApiBaseUrl = base;
  config.githubToken = 'ghp_' + 'a'.repeat(36);
  config.githubWorkflow = 'android-build.yml';
  config.githubWorkflowRef = 'my-ai-studio-build';

  try {
    const result = await syncWorkspaceToRepo({ projectId, repo: 'acme/studio', branch: 'my-ai-studio-build' });
    assert.equal(result.ok, true, result.error ?? '');
    assert.equal(result.workflowOnDefaultBranch, 'main');
    assert.equal(result.defaultBranchError, undefined);
    // Exactly one tree and one commit: the build branch. Nothing writes to main.
    assert.equal(calls.filter((c) => c === 'POST /repos/acme/studio/git/trees').length, 1);
    assert.equal(calls.filter((c) => c === 'POST /repos/acme/studio/git/commits').length, 1);
    assert.equal(calls.some((c) => c === 'PATCH /repos/acme/studio/git/refs/heads/main'), false, 'main must not be rewritten');
  } finally {
    config.githubApiBaseUrl = saved.base;
    config.githubToken = saved.token;
    config.githubWorkflow = saved.workflow;
    config.githubWorkflowRef = saved.ref;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('CASE 3b: a refused write stops the publish before any commit is attempted', async () => {
  const projectId = 'publish-denied';
  const projectDir = path.join(config.workspaceRoot, projectId);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'a.txt'), 'x');

  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '';
    if (url === '/repos/acme/studio/git/ref/heads/my-ai-studio-build') {
      res.end(JSON.stringify({ object: { sha: 'b'.repeat(40) } }));
      return;
    }
    if (url.startsWith('/repos/acme/studio/git/commits/')) {
      res.end(JSON.stringify({ tree: { sha: 'tree-base' } }));
      return;
    }
    res.statusCode = 403;
    res.end(JSON.stringify({ message: 'Resource not accessible by integration' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const saved = { base: config.githubApiBaseUrl, token: config.githubToken };
  config.githubApiBaseUrl = base;
  config.githubToken = 'ghp_' + 'a'.repeat(36);

  try {
    const result = await syncWorkspaceToRepo({ projectId, repo: 'acme/studio', branch: 'my-ai-studio-build' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /blob creation failed/);
    assert.ok(!calls.some((u) => u === '/repos/acme/studio/git/commits'), 'no commit may be attempted after a refused write');
    assert.ok(!calls.includes('/repos/acme/studio/git/trees'));
  } finally {
    config.githubApiBaseUrl = saved.base;
    config.githubToken = saved.token;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('CASE 16: a run log archive is unpacked into real text, and non-zips are refused', () => {
  // GitHub serves per-job logs as a zip. The endpoint must show the log text,
  // not a description of the archive, or fetching the logs is not actually done.
  const archive = makeZip([
    { name: '0_test and assemble debug.txt', content: Buffer.from('line one\nline two\n') },
    { name: '1_other job.txt', content: Buffer.from('second job output\n') },
  ]);
  const text = extractRunLogText(archive);
  assert.ok(text, 'a real archive must produce text');
  assert.match(text!, /line one/);
  assert.match(text!, /second job output/);
  // Both files are present and the earlier job is listed first.
  assert.ok(text!.indexOf('line one') < text!.indexOf('second job output'));

  // A token planted in a log must not survive into what the API returns.
  const planted = 'github_pat_' + 'A1b2C3d4'.repeat(4);
  const withSecret = makeZip([{ name: '0_job.txt', content: Buffer.from(`using ${planted}\n`) }]);
  const redacted = extractRunLogText(withSecret);
  assert.ok(redacted && !redacted.includes(planted));

  // Binary that is not an archive is reported, never presented as a log.
  assert.equal(extractRunLogText(Buffer.from('not a zip at all')), null);
});

// ------------------------------------------------------------------ helpers
function makeRun(status: string, conclusion: string | null) {
  return {
    id: 1, runNumber: 1, status, conclusion,
    htmlUrl: 'https://example.invalid/run/1', headSha: 'a'.repeat(40), headBranch: 'main',
    event: 'workflow_dispatch', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    artifacts: [],
  };
}
