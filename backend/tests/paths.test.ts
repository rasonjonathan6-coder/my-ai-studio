/**
 * Real unit tests for path confinement. These exercise the actual module: no
 * mocking, real filesystem for the symlink case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PathSecurityError,
  assertSafeCommandName,
  assertSafeSegment,
  resolveInside,
  resolveInsideExisting,
} from '../src/lib/paths.ts';

test('resolveInside keeps ordinary relative paths inside the root', () => {
  const root = '/srv/ws/p1';
  assert.equal(resolveInside(root, 'app/src/Main.kt'), path.join(root, 'app/src/Main.kt'));
  assert.equal(resolveInside(root, './README.md'), path.join(root, 'README.md'));
  assert.equal(resolveInside(root, 'a/b/../c.txt'), path.join(root, 'a/c.txt'));
});

test('resolveInside rejects traversal with ..', () => {
  const root = '/srv/ws/p1';
  for (const bad of ['../p2/secret', '../../etc/passwd', 'a/../../outside', '..']) {
    assert.throws(() => resolveInside(root, bad), PathSecurityError, `expected rejection for ${bad}`);
  }
});

test('resolveInside rejects absolute paths and drive letters', () => {
  const root = '/srv/ws/p1';
  for (const bad of ['/etc/passwd', '/srv/ws/p1/ok', 'C:\\Windows\\system32', 'D:/data']) {
    assert.throws(() => resolveInside(root, bad), PathSecurityError, `expected rejection for ${bad}`);
  }
});

test('resolveInside rejects NUL bytes and non-strings', () => {
  const root = '/srv/ws/p1';
  assert.throws(() => resolveInside(root, 'a\0b'), PathSecurityError);
  assert.throws(() => resolveInside(root, undefined as unknown as string), PathSecurityError);
});

test('resolveInside rejects a sibling directory sharing a prefix', () => {
  // /srv/ws/p1-evil must not be treated as being inside /srv/ws/p1.
  assert.throws(() => resolveInside('/srv/ws/p1', '../p1-evil/x'), PathSecurityError);
});

test('resolveInsideExisting follows a symlink and refuses to leave the root', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mas-paths-'));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');
  await fs.writeFile(path.join(root, 'inside.txt'), 'fine', 'utf8');
  await fs.symlink(outside, path.join(root, 'escape'));

  await assert.rejects(
    () => resolveInsideExisting(root, 'escape/secret.txt'),
    PathSecurityError,
    'a symlink pointing outside the root must be refused',
  );

  const ok = await resolveInsideExisting(root, 'inside.txt');
  assert.equal(ok, await fs.realpath(path.join(root, 'inside.txt')));

  await fs.rm(base, { recursive: true, force: true });
});

test('assertSafeSegment accepts project ids and rejects hostile names', () => {
  assert.equal(assertSafeSegment('9a88902f-76b0-4bba-b108-c752ea505c39'), '9a88902f-76b0-4bba-b108-c752ea505c39');
  assert.equal(assertSafeSegment('my_project.v2'), 'my_project.v2');

  for (const bad of ['..', '.', '', '../x', 'a/b', 'a\\b', '.hidden', 'a b', 'a\0b', 'x'.repeat(200)]) {
    assert.throws(() => assertSafeSegment(bad), PathSecurityError, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test('assertSafeCommandName only accepts bare executable names', () => {
  assert.equal(assertSafeCommandName('npm'), 'npm');
  assert.equal(assertSafeCommandName('gradlew'), 'gradlew');
  for (const bad of ['rm -rf /', 'a;b', 'a|b', 'a`b`', '../bin/sh', './gradlew', 'a$(b)', 'a&&b']) {
    assert.throws(() => assertSafeCommandName(bad), PathSecurityError, `expected rejection for ${bad}`);
  }
});
