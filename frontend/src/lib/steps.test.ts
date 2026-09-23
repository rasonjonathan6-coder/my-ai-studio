import { describe, expect, it } from 'vitest';
import { AGENT_STEPS, stepIndex, TERMINAL_STATUS_PILL } from './steps.ts';

describe('agent step mapping', () => {
  it('maps every backend phase key to a contiguous 0-based index', () => {
    AGENT_STEPS.forEach((step, i) => {
      expect(stepIndex(step.key)).toBe(i);
    });
  });

  it('returns -1 for phases that are not display steps', () => {
    expect(stepIndex(null)).toBe(-1);
    expect(stepIndex(undefined)).toBe(-1);
    expect(stepIndex('')).toBe(-1);
    expect(stepIndex('completed')).toBe(-1);
    expect(stepIndex('failed')).toBe(-1);
  });

  it('does not accept a partial or cased key', () => {
    expect(stepIndex('ANALYZING')).toBe(-1);
    expect(stepIndex('analyzin')).toBe(-1);
  });

  it('keeps the expected order', () => {
    expect(AGENT_STEPS.map((s) => s.key)).toEqual([
      'analyzing', 'planning', 'reading', 'editing',
      'running', 'testing', 'building', 'inspecting', 'fixing',
    ]);
  });

  it('maps every terminal status to a pill and never leaves a status unstyled', () => {
    for (const status of ['succeeded', 'failed', 'timeout', 'rejected'] as const) {
      expect(TERMINAL_STATUS_PILL[status]).toBeTruthy();
    }
    expect(TERMINAL_STATUS_PILL.succeeded).toBe('ok');
  });
});
