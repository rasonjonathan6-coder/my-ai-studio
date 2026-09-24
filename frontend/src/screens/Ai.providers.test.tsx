import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProvidersResponse } from '../api/types.ts';

/**
 * The provider panel must render exactly what the backend reports. These tests
 * pin the real /api/ai/providers shape: a provider that was never exercised must
 * read NOT TESTED and must never show a number the server did not observe.
 */
vi.mock('../api/client.ts', () => ({
  api: {
    testAiProvider: vi.fn(),
    resetAiProvider: vi.fn(),
    probeAiProvider: vi.fn(),
    autoProbeAi: vi.fn(),
  },
}));

const { ProviderPanel } = await import('./Ai.tsx');

const response: AiProvidersResponse = {
  defaultProvider: 'auto',
  order: ['openrouter', 'gemini', 'groq'],
  priority: ['openrouter', 'gemini', 'groq', 'cerebras'],
  cooldownMs: 30000,
  providers: [
    {
      id: 'openrouter', label: 'OpenRouter', local: false, configured: true,
      status: 'CONFIGURED', connection: 'NOT_TESTED', model: 'qwen/qwen3.8-27b:free',
      endpoint: 'https://openrouter.ai/api/v1', cooling: false, cooldownUntil: null, cooldownReason: null,
      capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
      tier: 'free', tierReason: 'the :free variants are priced $0', freeModels: ['nvidia/nemotron-3-ultra-550b-a55b:free'],
    },
    {
      id: 'gemini', label: 'Gemini', local: false, configured: true,
      status: 'CONFIGURED', connection: 'NOT_TESTED', model: 'gemini-3.5-flash-lite',
      endpoint: 'https://generativelanguage.googleapis.com', cooling: true,
      cooldownUntil: new Date(Date.now() + 60000).toISOString(), cooldownReason: 'QUOTA_RATE_LIMIT',
      capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
      tier: 'free', tierReason: 'AI Studio free tier', freeModels: ['gemini-3.5-flash-lite'],
    },
    {
      id: 'groq', label: 'Groq', local: false, configured: false,
      status: 'NOT_CONFIGURED', connection: 'NOT_TESTED', model: 'qwen/qwen3.8-27b',
      endpoint: 'https://api.groq.com/openai/v1', cooling: false, cooldownUntil: null, cooldownReason: null,
      capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
      tier: 'free', tierReason: 'Groq free tier', freeModels: ['qwen/qwen3.8-27b'],
    },
    {
      id: 'cerebras', label: 'Cerebras', local: false, configured: false,
      status: 'NOT_CONFIGURED', connection: 'NOT_TESTED', model: 'gpt-oss-120b',
      endpoint: 'https://api.cerebras.ai/v1', cooling: false, cooldownUntil: null, cooldownReason: null,
      capabilities: { agent: false, chat: true, streaming: true, jsonMode: true, agentNote: 'CHAT ONLY: no agent tool protocol observed.' },
      tier: 'paid', tierReason: 'observed HTTP 402 insufficient credits', freeModels: [],
    },
  ],
  providerStates: [
    {
      id: 'openrouter', label: 'OpenRouter', local: false, configured: true, available: true,
      lastStatusCode: 200, lastError: null, lastErrorAt: null, cooldownUntil: null, cooldownReason: null,
      cooldownStrike: 0, requestCount: 3, successCount: 3, failureCount: 0,
      rateLimitRemainingRequests: null, rateLimitRemainingTokens: null, rateLimitResetAt: null,
      capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
    },
    {
      id: 'gemini', label: 'Gemini', local: false, configured: true, available: false,
      lastStatusCode: 429, lastError: 'HTTP 429 quota', lastErrorAt: new Date().toISOString(),
      cooldownUntil: new Date(Date.now() + 60000).toISOString(), cooldownReason: 'QUOTA_RATE_LIMIT',
      cooldownStrike: 2, requestCount: 1, successCount: 0, failureCount: 1,
      rateLimitRemainingRequests: 0, rateLimitRemainingTokens: null,
      rateLimitResetAt: new Date(Date.now() + 60000).toISOString(),
      capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
    },
    {
      id: 'cerebras', label: 'Cerebras', local: false, configured: false, available: false,
      lastStatusCode: null, lastError: null, lastErrorAt: null, cooldownUntil: null, cooldownReason: null,
      cooldownStrike: 0, requestCount: 0, successCount: 0, failureCount: 0,
      rateLimitRemainingRequests: null, rateLimitRemainingTokens: null, rateLimitResetAt: null,
      capabilities: { agent: false, chat: true, streaming: true, jsonMode: true, agentNote: 'CHAT ONLY: no agent tool protocol observed.' },
    },
  ],
  current: { provider: 'openrouter', label: 'OpenRouter', model: 'qwen/qwen3.8-27b:free', reason: 'first configured provider in priority order' },
  auto: { ready: ['openrouter'], cooling: ['gemini'], unconfigured: ['groq', 'cerebras'] },
  recentAttempts: [
    { provider: 'gemini', model: 'gemini-3.6-flash', endpoint: 'x', outcome: 'fallback', status: 429, classification: 'QUOTA_RATE_LIMIT', message: 'quota', at: new Date().toISOString() },
    { provider: 'openrouter', model: 'qwen/qwen3.8-27b:free', endpoint: 'x', outcome: 'ok', status: 200, at: new Date().toISOString() },
  ],
  requestCounters: {
    openrouter: { date: '2026-01-01', attempts: 3, ok: 3, failed: 0 },
  },
  quotaRemaining: 'unknown',
  freeOnly: true,
  models: [
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'openrouter', free: true, coding: true,
      tools: true, context: 1000000, evidence: 'OR /models price $0; 200 + tool_calls observed',
      status: 'AVAILABLE', lastHttpStatus: 200, lastTested: new Date().toISOString(), lastMessage: null, observedVia: 'completion',
    },
    {
      id: 'poolside/laguna-s-2.1:free', provider: 'openrouter', free: true, coding: true,
      tools: true, context: 262144, evidence: 'OR /models price $0; tools listed',
      status: 'RATE_LIMITED', lastHttpStatus: 429, lastTested: new Date().toISOString(), lastMessage: 'upstream 429', observedVia: 'completion',
    },
  ],
  modelSummary: {
    freeProviders: 5, freeModels: 2, available: 1, rateLimited: 1,
    paymentRequired: 0, notAvailable: 0, notTested: 0, lastSync: null,
  },
  freePlan: [
    { provider: 'openrouter', label: 'OpenRouter', tier: 'free', candidates: ['nvidia/nemotron-3-ultra-550b-a55b:free'], skippedReason: null },
    { provider: 'cerebras', label: 'Cerebras', tier: 'paid', candidates: [], skippedReason: 'PAID_PROVIDER: observed HTTP 402' },
  ],
};

afterEach(cleanup);

function renderPanel(overrides: Partial<AiProvidersResponse> = {}) {
  return render(
    <ProviderPanel
      providers={{ ...response, ...overrides }}
      selected="auto"
      onSelect={() => {}}
      disabled={false}
      onChanged={() => {}}
      onError={() => {}}
    />,
  );
}

describe('ProviderPanel', () => {
  it('renders every configured provider with its observed status', () => {
    renderPanel();
    expect(screen.getAllByText('OpenRouter').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Cerebras').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('AVAILABLE')).toBeTruthy();
    expect(screen.getByText('COOLING DOWN')).toBeTruthy();
    expect(screen.getAllByText('NOT CONFIGURED').length).toBeGreaterThanOrEqual(2);
  });

  it('leaves an unexercised provider as NOT TESTED rather than inventing a status', () => {
    renderPanel({
      providerStates: response.providerStates.map((s) => ({ ...s, available: false, lastStatusCode: null, requestCount: 0, successCount: 0, failureCount: 0 })),
      providers: response.providers.map((p) => ({ ...p, cooling: false })),
      current: { provider: 'openrouter', label: 'OpenRouter', model: 'm', reason: 'default' },
    });
    // Only the two keyed providers can be NOT TESTED; the other two have no key.
    expect(screen.getAllByText('NOT TESTED').length).toBe(2);
    expect(screen.queryByText('AVAILABLE')).toBeNull();
  });

  it('shows the reason AUTO would pick the current provider', () => {
    renderPanel();
    expect(screen.getByText(/first configured provider in priority order/)).toBeTruthy();
  });

  it('explains a chat-only provider instead of presenting it as agent-capable', () => {
    renderPanel();
    expect(screen.getAllByText(/CHAT ONLY/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows an observed rate-limit figure but never claims a quota it was not told', () => {
    renderPanel();
    // Gemini reported 0 remaining, which is a fact; it must be rendered as such.
    expect(screen.getByText(/0 req left/)).toBeTruthy();
  });

  it('never renders a raw key, even when the provider is configured', () => {
    renderPanel();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/sk-or-|AIza|gsk_/);
    expect(text).not.toContain('undefined');
  });

  it('survives an empty provider list without throwing', () => {
    renderPanel({ providers: [], providerStates: [], auto: { ready: [], cooling: [], unconfigured: [] }, recentAttempts: [] });
    // StatePill renders the label lowercased for display.
    expect(screen.getByText(/no provider ready/i)).toBeTruthy();
  });
});
