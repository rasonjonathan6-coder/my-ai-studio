import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../src/server.ts';

/**
 * The Android emulator preview was removed from the product. These tests drive
 * the real Express app over a real socket, so they describe what a client
 * actually receives now - not a hand-built object and not a mock - and they fail
 * loudly if the removed surface is ever reintroduced.
 */
let server: Server;
let base: string;

before(async () => {
  const app = await createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('the emulator probe endpoint is gone', async () => {
  const res = await fetch(`${base}/api/system/emulator`);
  assert.equal(res.status, 404, 'GET /api/system/emulator must not resolve');
});

test('the project preview endpoint is gone', async () => {
  const res = await fetch(`${base}/api/projects/00000000-0000-0000-0000-000000000000/preview`, {
    method: 'POST',
  });
  // No route is registered, so the request must not reach a handler. It may be
  // rejected earlier by auth, but it must never answer 200 with a preview body.
  assert.notEqual(res.status, 200);
  const text = await res.text();
  assert.ok(!/ANDROID PREVIEW/.test(text), 'no preview payload is produced');
});

test('system status no longer reports an emulator, and keeps the build toolchain', async () => {
  const res = await fetch(`${base}/api/system/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const names: string[] = body.probes.map((p: { name: string }) => p.name);

  assert.ok(!names.includes('androidEmulator'), 'the emulator probe is not reported');
  assert.ok(!names.includes('adb'), 'adb is no longer a standalone probe');

  // The toolchain that real APK builds need must survive the removal.
  for (const required of ['java', 'gradle', 'androidSdk']) {
    assert.ok(names.includes(required), `${required} probe must remain`);
  }
});
