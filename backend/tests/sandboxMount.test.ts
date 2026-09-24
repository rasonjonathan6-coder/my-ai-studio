/**
 * Real tests for the sandbox bind-mount path mapping.
 *
 * The sandbox is launched as a sibling container, so the Docker daemon resolves
 * a mount source on the host, not inside the backend container. When the backend
 * is containerised, WORKSPACE_PATH (/data/workspaces) does not exist on the host
 * and Docker silently mounts an empty directory, so commands ran against an
 * empty workspace. toHostPath performs the translation.
 *
 * The module reads config at import time, so each case runs in its own child
 * process with the relevant environment set. No mocking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep;

function runToHostPath(env: Record<string, string>, input: string): Promise<string> {
  const script = `const { toHostPath } = await import('${BACKEND}src/services/commandRunner.ts');
    console.log(JSON.stringify({ out: toHostPath(${JSON.stringify(input)}) }));`;
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: BACKEND,
      env: { ...process.env, NODE_ENV: 'development', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${out.slice(0, 400)}`));
      const line = out.split('\n').reverse().find((l) => l.startsWith('{'));
      if (!line) return reject(new Error(`no result: ${out.slice(0, 400)}`));
      resolve(JSON.parse(line).out);
    });
  });
}

test('toHostPath returns the path unchanged when no host root is configured', async () => {
  // The bare-metal case: the backend and the daemon share a filesystem.
  const out = await runToHostPath(
    { WORKSPACE_PATH: '/srv/ws', SANDBOX_WORKSPACE_HOST_PATH: '' },
    '/srv/ws/proj-1',
  );
  assert.equal(out, '/srv/ws/proj-1');
});

test('toHostPath rewrites a containerised workspace path to its host path', async () => {
  const out = await runToHostPath(
    { WORKSPACE_PATH: '/data/workspaces', SANDBOX_WORKSPACE_HOST_PATH: '/srv/myai-studio-data/workspaces' },
    '/data/workspaces/abc-123',
  );
  assert.equal(out, '/srv/myai-studio-data/workspaces/abc-123');
});

test('toHostPath maps a nested directory and the root itself', async () => {
  const env = {
    WORKSPACE_PATH: '/data/workspaces',
    SANDBOX_WORKSPACE_HOST_PATH: '/srv/myai-studio-data/workspaces',
  };
  assert.equal(
    await runToHostPath(env, '/data/workspaces/proj/app/src'),
    '/srv/myai-studio-data/workspaces/proj/app/src',
  );
  assert.equal(await runToHostPath(env, '/data/workspaces'), '/srv/myai-studio-data/workspaces');
});

test('toHostPath passes through paths outside the workspace tree', async () => {
  // No mapping applies, so the path must not be rewritten into something wrong.
  const out = await runToHostPath(
    { WORKSPACE_PATH: '/data/workspaces', SANDBOX_WORKSPACE_HOST_PATH: '/srv/myai-studio-data/workspaces' },
    '/tmp/elsewhere',
  );
  assert.equal(out, '/tmp/elsewhere');
});

test('toHostPath does not rewrite a sibling directory with a shared prefix', async () => {
  // "/data/workspaces-archive" starts with "/data/workspaces" as a string but is
  // a different directory; a naive startsWith check would map it incorrectly.
  const out = await runToHostPath(
    { WORKSPACE_PATH: '/data/workspaces', SANDBOX_WORKSPACE_HOST_PATH: '/srv/ws' },
    '/data/workspaces-archive/x',
  );
  assert.equal(out, '/data/workspaces-archive/x');
});
