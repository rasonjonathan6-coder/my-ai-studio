/**
 * Tests for the loop guards: the daily budget and the minimum gap.
 *
 * These are the limits that keep an unattended watchdog from consuming the
 * sandbox quota when a studio cannot start for a reason a rebuild will not fix.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyState,
  evaluateBudget,
  readState,
  recentRebuilds,
  recordRebuild,
  writeState,
} from '../src/state.mjs';

const SETTINGS = { maxRebuildsPerDay: 3, minRebuildGapMs: 600_000 };
const NOW = Date.parse('2026-01-02T12:00:00.000Z');

function stateWith(times) {
  return { rebuilds: times.map((at, i) => ({ at, url: `https://s${i}.example`, sandboxId: `sb${i}` })) };
}

describe('evaluateBudget', () => {
  it('allows a rebuild when nothing has been rebuilt', () => {
    const result = evaluateBudget(emptyState(), SETTINGS, NOW);
    assert.equal(result.allowed, true);
  });

  it('refuses once the daily budget is reached', () => {
    const state = stateWith([
      '2026-01-02T09:00:00.000Z',
      '2026-01-02T10:00:00.000Z',
      '2026-01-02T11:00:00.000Z',
    ]);
    const result = evaluateBudget(state, SETTINGS, NOW);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /budget exhausted/);
  });

  it('ignores rebuilds older than 24 hours', () => {
    const state = stateWith([
      '2026-01-01T08:00:00.000Z',
      '2026-01-01T09:00:00.000Z',
      '2026-01-01T10:00:00.000Z',
    ]);
    const result = evaluateBudget(state, SETTINGS, NOW);
    assert.equal(result.allowed, true);
  });

  it('refuses a rebuild inside the minimum gap', () => {
    const state = stateWith(['2026-01-02T11:55:00.000Z']);
    const result = evaluateBudget(state, SETTINGS, NOW);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /waiting/);
    assert.equal(result.waitMs, 600_000 - 300_000);
  });

  it('allows a rebuild once the gap has passed', () => {
    const state = stateWith(['2026-01-02T11:40:00.000Z']);
    assert.equal(evaluateBudget(state, SETTINGS, NOW).allowed, true);
  });

  it('treats an unparseable timestamp as absent rather than blocking forever', () => {
    const state = { rebuilds: [{ at: 'not a date', url: 'x', sandboxId: 'y' }] };
    assert.equal(recentRebuilds(state, NOW).length, 0);
    assert.equal(evaluateBudget(state, SETTINGS, NOW).allowed, true);
  });
});

describe('recordRebuild', () => {
  it('appends without mutating the previous state', () => {
    const before = emptyState();
    const after = recordRebuild(before, { url: 'https://s.example', sandboxId: 'sb1', at: '2026-01-02T12:00:00.000Z' });
    assert.equal(before.rebuilds.length, 0);
    assert.equal(after.rebuilds.length, 1);
    assert.equal(after.rebuilds[0].url, 'https://s.example');
  });

  it('keeps only the outcome, never a credential', () => {
    const after = recordRebuild(emptyState(), { url: 'https://s.example', sandboxId: 'sb1' });
    const serialised = JSON.stringify(after);
    assert.doesNotMatch(serialised, /token|key|secret|password/i);
  });
});

describe('state file', () => {
  it('returns empty state when the file does not exist', async () => {
    const state = await readState(join(tmpdir(), 'watchdog-does-not-exist', 'state.json'));
    assert.deepEqual(state, emptyState());
  });

  it('round-trips through the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watchdog-state-'));
    try {
      const path = join(dir, 'nested', 'state.json');
      const written = recordRebuild(emptyState(), { url: 'https://s.example', sandboxId: 'sb1' });
      await writeState(path, written);
      assert.deepEqual(await readState(path), written);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not leave a temporary file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watchdog-state-'));
    try {
      const path = join(dir, 'state.json');
      await writeState(path, emptyState());
      await assert.rejects(() => readFile(`${path}.tmp`, 'utf8'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts from empty when the file is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watchdog-state-'));
    try {
      const path = join(dir, 'state.json');
      await writeFile(path, 'not json', 'utf8');
      assert.deepEqual(await readState(path), emptyState());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
