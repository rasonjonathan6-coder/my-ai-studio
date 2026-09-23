/**
 * The job queue is what stops a wedged agent run, build or test from holding a
 * worker slot forever. These tests drive a real JobQueue with real timers and
 * real promises; nothing is mocked, so a regression in the timeout or in slot
 * release would show up here rather than as a stuck run in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../src/services/jobQueue.ts';

/** Resolves after ms, so a job can be made to outlive its timeout. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a job that exceeds its timeout is rejected and releases its slot', async () => {
  const queue = new JobQueue(1);

  await assert.rejects(
    queue.submit({
      id: 'slow',
      timeoutMs: 20,
      run: async () => {
        await sleep(500);
        return 'never';
      },
    }),
    (err: unknown) => err instanceof Error && /JOB_TIMEOUT/.test(err.message),
  );

  // The slot must be free again; otherwise a single hang permanently blocks the
  // queue and every later run reports "queued" forever.
  assert.equal(queue.active, 0, 'timed-out job must not keep its slot');
  assert.equal(queue.pending, 0, 'no job should be left pending');

  const result = await queue.submit({ id: 'after', timeoutMs: 1000, run: async () => 'ok' });
  assert.equal(result, 'ok', 'queue must accept new work after a timeout');
});

test('a timed-out job receives an abort signal so it can stop its own work', async () => {
  const queue = new JobQueue(1);
  let sawAbort = false;

  await assert.rejects(
    queue.submit({
      id: 'aborts',
      timeoutMs: 20,
      run: (signal) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted by queue'));
          });
        }),
    }),
  );

  assert.equal(sawAbort, true, 'the queue must abort the signal when it times out');
});

test('concurrency is capped and the queue drains in order as slots free up', async () => {
  const queue = new JobQueue(2);
  const started: string[] = [];
  const finished: string[] = [];
  let peak = 0;
  const track = () => {
    peak = Math.max(peak, queue.active);
  };

  const job = (id: string, ms: number) => ({
    id,
    timeoutMs: 5000,
    run: async () => {
      started.push(id);
      track();
      await sleep(ms);
      finished.push(id);
      track();
      return id;
    },
  });

  await Promise.all([
    queue.submit(job('a', 120)),
    queue.submit(job('b', 40)),
    queue.submit(job('c', 10)),
    queue.submit(job('d', 10)),
  ]);

  assert.ok(peak <= 2, `concurrency must not exceed the cap, saw ${peak}`);
  assert.deepEqual(finished.slice().sort(), ['a', 'b', 'c', 'd'], 'every job must complete');
  assert.deepEqual(started.slice(0, 2), ['a', 'b'], 'the first two jobs start immediately');
  assert.equal(queue.active, 0);
  assert.equal(queue.pending, 0);
});

test('cancel aborts a running job and reports whether it found one', async () => {
  const queue = new JobQueue(1);
  let aborted = false;

  const running = queue.submit({
    id: 'cancellable',
    timeoutMs: 5000,
    run: (signal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('cancelled'));
        });
      }),
  });

  // Let submit() register the job before cancelling it.
  await sleep(10);
  assert.equal(queue.cancel('cancellable'), true, 'cancel must find the running job');
  await assert.rejects(running);
  assert.equal(aborted, true);

  assert.equal(queue.cancel('cancellable'), false, 'cancel must report a miss after completion');
});
