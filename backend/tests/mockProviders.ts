/**
 * Test-only mock providers.
 *
 * They implement the same `ProviderService` surface as the real adapters but
 * answer from a fixed script, so the failover chain, the error classification
 * and the cooldown logic can be exercised without sending a single request to a
 * real API. Nothing here is imported by production code.
 */
import type { ChatOptions, ChatOutcome, ProviderCapabilities } from '../src/services/providerClient.ts';
import type { ProviderService } from '../src/services/providers.ts';

export interface MockScript {
  /** HTTP status to answer with; 200 means success. */
  status: number;
  /** Body text, used for the quota-pattern match. */
  body?: string;
  /** Overrides the failure message. */
  message?: string;
  /** Response headers, e.g. retry-after or rate-limit figures. */
  headers?: Record<string, string>;
  /** When set, the call rejects instead of answering, to simulate a timeout. */
  throws?: boolean;
}

export const MOCK_CAPABILITIES: ProviderCapabilities = { agent: true, chat: true, streaming: false, jsonMode: true };

/**
 * A provider that answers with a fixed script every time. Each call is counted,
 * so a test can prove the router did not call a cooling provider again.
 */
export class MockProvider implements ProviderService {
  public calls = 0;
  private readonly name: string;
  /** Mutable so a test can flip a provider from failing to healthy. */
  public script: MockScript;
  private readonly configured: boolean;

  public constructor(name: string, script: MockScript, configured = true) {
    this.name = name;
    this.script = script;
    this.configured = configured;
  }

  public isConfigured(): boolean {
    return this.configured;
  }

  public status(): { configured: boolean; model: string; baseUrl: string } {
    return { configured: this.configured, model: `mock-model-${this.name}`, baseUrl: `http://mock.invalid/${this.name}` };
  }

  public capabilities(): ProviderCapabilities {
    return MOCK_CAPABILITIES;
  }

  public async listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    return { ok: true, models: [`mock-model-${this.name}`] };
  }

  public async chat(_options: ChatOptions): Promise<ChatOutcome> {
    this.calls += 1;
    if (this.script.throws) {
      return { ok: false, kind: 'timeout', message: 'mock timeout', retryable: true, classification: 'TEMPORARY_FAILURE' };
    }
    const rateLimit = {
      limitRequests: this.script.headers?.['x-ratelimit-limit-requests'] !== undefined
        ? Number(this.script.headers['x-ratelimit-limit-requests']) : null,
      remainingRequests: this.script.headers?.['x-ratelimit-remaining-requests'] !== undefined
        ? Number(this.script.headers['x-ratelimit-remaining-requests']) : null,
      limitTokens: null,
      remainingTokens: this.script.headers?.['x-ratelimit-remaining-tokens'] !== undefined
        ? Number(this.script.headers['x-ratelimit-remaining-tokens']) : null,
      resetRequestsAt: null,
      resetTokensAt: null,
      retryAfterAt: null,
    };

    if (this.script.status === 200) {
      return {
        ok: true,
        content: `mock reply from ${this.name}`,
        model: `mock-model-${this.name}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        rateLimit,
        raw: {},
      };
    }

    const body = this.script.body ?? '';
    if (this.script.status === 429) {
      const quotaExhausted = /quota|exhausted/i.test(body);
      const retryAfter = Number(this.script.headers?.['retry-after']);
      return {
        ok: false,
        kind: 'rate_limited',
        message: this.script.message ?? `mock 429 from ${this.name}`,
        status: 429,
        retryable: !quotaExhausted,
        quotaExhausted,
        classification: 'QUOTA_RATE_LIMIT',
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      };
    }
    if (this.script.status === 401) {
      return { ok: false, kind: 'http_error', message: this.script.message ?? 'mock 401', status: 401, retryable: false, classification: 'AUTHENTICATION' };
    }
    if (this.script.status === 403) {
      return { ok: false, kind: 'http_error', message: this.script.message ?? 'mock 403', status: 403, retryable: false, classification: 'PERMISSION' };
    }
    if (this.script.status === 400) {
      return { ok: false, kind: 'http_error', message: this.script.message ?? 'mock 400', status: 400, retryable: false, classification: 'BAD_REQUEST' };
    }
    if (this.script.status === 404) {
      return { ok: false, kind: 'model_unavailable', message: this.script.message ?? 'mock 404', status: 404, retryable: false, classification: 'MODEL_UNAVAILABLE' };
    }
    return { ok: false, kind: 'http_error', message: this.script.message ?? `mock ${this.script.status}`, status: this.script.status, retryable: this.script.status >= 500, classification: this.script.status >= 500 ? 'TEMPORARY_FAILURE' : 'BAD_REQUEST' };
  }
}

export const mockSuccess = (name: string): MockProvider => new MockProvider(name, { status: 200 });
export const mock429 = (name: string, opts: Partial<MockScript> = {}): MockProvider => new MockProvider(name, { status: 429, ...opts });
export const mock401 = (name: string): MockProvider => new MockProvider(name, { status: 401 });
export const mock500 = (name: string): MockProvider => new MockProvider(name, { status: 500 });
export const mockTimeout = (name: string): MockProvider => new MockProvider(name, { status: 0, throws: true });
