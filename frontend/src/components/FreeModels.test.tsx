import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProvidersResponse } from '../api/types.ts';

/**
 * The free-model browser must show only what the server observed. These cases
 * pin the two claims that matter: a model's declared attributes carry their
 * source, and a never-called model reads NOT_TESTED rather than AVAILABLE.
 */
vi.mock('../api/client.ts', () => ({
  api: {
    testAiModel: vi.fn(),
    aiModels: vi.fn(),
    syncAiModels: vi.fn(),
  },
}));

const { FreeModelsPanel } = await import('../components/FreeModels.tsx');

const baseProvider = {
  id: 'openrouter' as const, label: 'OpenRouter', local: false, configured: true,
  status: 'CONFIGURED' as const, connection: 'NOT_TESTED' as const, model: 'qwen/qwen3.8-27b:free',
  endpoint: 'https://openrouter.ai/api/v1', cooling: false, cooldownUntil: null, cooldownReason: null,
  capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
  tier: 'free' as const, tierReason: 'the :free variants are priced $0', freeModels: ['a:free'],
};

const response: AiProvidersResponse = {
  defaultProvider: 'auto',
  order: ['openrouter'],
  priority: ['openrouter'],
  cooldownMs: 30000,
  providers: [baseProvider],
  providerStates: [],
  current: { provider: 'openrouter', label: 'OpenRouter', model: 'a:free', reason: 'default' },
  auto: { ready: ['openrouter'], cooling: [], unconfigured: [] },
  recentAttempts: [],
  requestCounters: {},
  quotaRemaining: 'unknown',
  freeOnly: true,
  models: [
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'openrouter', free: true, coding: true,
      tools: true, context: 1000000, evidence: 'OR /models price $0; 200 + tool_calls observed',
      status: 'AVAILABLE', lastHttpStatus: 200, lastTested: new Date().toISOString(), lastMessage: null, observedVia: 'completion',
    },
    {
      id: 'never/called:free', provider: 'openrouter', free: true, coding: false,
      tools: false, context: 32768, evidence: 'added by catalogue sync: priced $0; attributes not yet probed',
      status: 'NOT_TESTED', lastHttpStatus: null, lastTested: null, lastMessage: null, observedVia: 'catalogue',
    },
  ],
  modelSummary: {
    freeProviders: 5, freeModels: 2, available: 1, rateLimited: 0,
    paymentRequired: 0, notAvailable: 0, notTested: 1, lastSync: null,
  },
  freePlan: [],
};

afterEach(cleanup);

describe('FreeModelsPanel', () => {
  it('marks a real observation as AVAILABLE and an unprobed model as NOT_TESTED', () => {
    render(<FreeModelsPanel providers={response} onError={() => {}} />);
    expect(screen.getByText(/AVAILABLE/)).toBeTruthy();
    expect(screen.getByText(/NOT_TESTED/)).toBeTruthy();
  });

  it('shows the source of every declared attribute', () => {
    render(<FreeModelsPanel providers={response} onError={() => {}} />);
    expect(screen.getByText(/source: OR \/models price \$0/)).toBeTruthy();
    expect(screen.getByText(/source: added by catalogue sync/)).toBeTruthy();
  });

  it('filters to free coding models without hiding the provider', () => {
    render(<FreeModelsPanel providers={response} onError={() => {}} />);
    // The default filter lists free models, so the provider label is present.
    expect(screen.getAllByText('OpenRouter').length).toBeGreaterThanOrEqual(1);
    // The coding badge sits on the coding-capable model's row.
    expect(screen.getByText(/· coding/)).toBeTruthy();
  });

  it('states FREE_ONLY in the header so paid routing is visibly off', () => {
    render(<FreeModelsPanel providers={response} onError={() => {}} />);
    // StatePill renders the label lowercased.
    expect(screen.getByText('free only')).toBeTruthy();
  });
});
