/**
 * Real tests for structured-log redaction.
 *
 * These drive the actual logger and read back what it writes to stdout, so the
 * behaviour under test is the behaviour a deployment gets. Two properties
 * matter: a credential value must never reach a log line, and a field that only
 * *describes* a credential (tokenKind, credentialSource) must survive, because
 * masking those to [REDACTED] makes the credential state impossible to debug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../src/lib/logger.ts';

const FINE_GRAINED = 'github_pat_11CJB7ERY' + 'a'.repeat(60);

function capture(fn: () => void): string {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const captureWrite = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  process.stdout.write = captureWrite as typeof process.stdout.write;
  process.stderr.write = captureWrite as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return lines.join('');
}

test('a descriptive field is preserved so credential state stays debuggable', () => {
  const out = capture(() => {
    logger.info('github credential resolved', {
      source: 'database',
      fingerprint: '0d6ba110a99a3b3a',
      tokenKind: 'fine-grained-pat',
      tokenConfigured: true,
    });
  });
  assert.ok(out.includes('"tokenKind":"fine-grained-pat"'), `tokenKind was masked: ${out}`);
  assert.ok(out.includes('"source":"database"'));
  assert.ok(!out.includes('[REDACTED]'), `no descriptive field should be masked: ${out}`);
});

test('a field that carries a credential is masked', () => {
  const out = capture(() => {
    logger.info('probe', { token: FINE_GRAINED, authorization: `Bearer ${FINE_GRAINED}` });
  });
  assert.ok(!out.includes(FINE_GRAINED), 'the credential must not reach the log');
  assert.ok(!out.includes('github_pat_'), 'not even a fragment of the credential may appear');
});

test('a credential embedded in a message is masked', () => {
  const out = capture(() => {
    logger.warn(`using credential ${FINE_GRAINED} for github`);
  });
  assert.ok(!out.includes(FINE_GRAINED));
  assert.ok(out.includes('[REDACTED]'));
});

test('an absent secret field is reported as null rather than as masked text', () => {
  const out = capture(() => {
    logger.info('github credential resolved', { tokenKind: null });
  });
  assert.ok(out.includes('"tokenKind":null'), `null must stay null: ${out}`);
});
