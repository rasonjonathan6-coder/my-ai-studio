/**
 * Real tests for the session cookie policy. Config is read once at module load,
 * so each case runs in a real child process with its own environment and reads
 * back the resolved values. Nothing is mocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BACKEND = new URL('..', import.meta.url).pathname;

function runConfig(env: Record<string, string>): string {
  return execFileSync(
    'node',
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `const { config } = await import('${BACKEND}src/config/index.ts');
       console.log(JSON.stringify({ sameSite: config.sessionCookieSameSite, secure: config.sessionCookieSecure }));`,
    ],
    { env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function resolveConfig(env: Record<string, string>): { sameSite: string; secure: boolean } {
  return JSON.parse(runConfig(env).trim().split('\n').pop() as string);
}

// A production run must declare its execution backend, otherwise the
// host-execution guard refuses to start. These cases are about cookie policy,
// so they state the sandbox explicitly and keep the two concerns separate.
const PROD = { NODE_ENV: 'production', SANDBOX_ENABLED: 'true' };

test('defaults to lax and non-secure outside production', () => {
  assert.deepEqual(resolveConfig({ NODE_ENV: 'development', SESSION_COOKIE_SAMESITE: '' }), {
    sameSite: 'lax',
    secure: false,
  });
});

test('none forces Secure, because browsers reject None without it', () => {
  assert.deepEqual(resolveConfig({ NODE_ENV: 'development', SESSION_COOKIE_SAMESITE: 'none' }), {
    sameSite: 'none',
    secure: true,
  });
});

test('production is always Secure even with lax', () => {
  assert.deepEqual(
    resolveConfig({ ...PROD, SESSION_COOKIE_SAMESITE: 'lax', JWT_SECRET: 'x'.repeat(40) }),
    { sameSite: 'lax', secure: true },
  );
});

test('an invalid SameSite value fails rather than silently defaulting', () => {
  assert.throws(() =>
    runConfig({ NODE_ENV: 'development', SESSION_COOKIE_SAMESITE: 'sideways' }),
  );
});
