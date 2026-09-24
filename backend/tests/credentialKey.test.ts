/**
 * Real tests for the credential-encryption key resolution.
 *
 * Config is read once at module load, so each case runs in a real child process
 * with its own environment and reads back the resolved value. Nothing is mocked.
 *
 * The property under test is durability: a stored GitHub credential is
 * encrypted with a key derived from this value, so if the key changes on every
 * process start the credential cannot be decrypted after a restart. That is
 * exactly what happened when the key was derived from a randomly generated
 * JWT_SECRET, and these cases pin the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const BACKEND = new URL('..', import.meta.url).pathname;

function resolve(env: Record<string, string>): { key: string; stable: boolean } {
  const script = `const { config } = await import('${BACKEND}src/config/index.ts');
    console.log(JSON.stringify({ key: config.credentialKey, stable: config.credentialKeyIsStable }));`;
  const out = execFileSync(
    'node',
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    {
      env: { ...process.env, MY_AI_STUDIO_CREDENTIAL_KEY: '', JWT_SECRET: '', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(out.trim().split('\n').pop() as string);
}

test('a dedicated credential key is used when provided and reported as stable', () => {
  const { key, stable } = resolve({ MY_AI_STUDIO_CREDENTIAL_KEY: 'k'.repeat(64), JWT_SECRET: 'j'.repeat(64) });
  assert.equal(key, 'k'.repeat(64));
  assert.equal(stable, true);
});

test('the credential key is independent of JWT_SECRET so rotating sessions does not lock the credential out', () => {
  const a = resolve({ MY_AI_STUDIO_CREDENTIAL_KEY: 'same-key-value', JWT_SECRET: 'first-secret' });
  const b = resolve({ MY_AI_STUDIO_CREDENTIAL_KEY: 'same-key-value', JWT_SECRET: 'second-secret' });
  assert.equal(a.key, b.key, 'the credential key must not change when JWT_SECRET does');
  assert.equal(a.stable, true);
});

test('JWT_SECRET is the fallback when no dedicated key is set', () => {
  const { key, stable } = resolve({ JWT_SECRET: 'fallback-secret-value' });
  assert.equal(key, 'fallback-secret-value');
  assert.equal(stable, true);
});

test('with neither key set the key is not stable, which is reported rather than hidden', () => {
  const { stable } = resolve({});
  assert.equal(stable, false, 'an ephemeral key must be flagged as unstable');
});

test('an ephemeral key differs between processes, which is why it is flagged', () => {
  const a = resolve({});
  const b = resolve({});
  assert.notEqual(a.key, b.key, 'two processes without a configured key must not share a key');
});
