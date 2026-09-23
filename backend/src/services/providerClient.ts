/**
 * Generic chat-completions client for any OpenAI-compatible provider.
 *
 * OpenRouter, Google Gemini and Groq all expose the same request/response
 * shape, but each has its own key, endpoint and limit semantics. This class
 * holds the transport, retry and error-mapping logic once; a provider supplies
 * its settings through a getter so tests can point it at a local server.
 *
 * Settings are read per call rather than captured at construction, which is
 * what lets the same instance follow a config change without being rebuilt.
 */
import { logger, redact } from '../lib/logger.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  responseFormatJson?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  ok: true;
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  raw: unknown;
}

export interface ChatFailure {
  ok: false;
  kind: 'not_configured' | 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' | 'network_error' | 'model_unavailable' | 'aborted';
  message: string;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  /**
   * True when a 429 was a hard quota (daily free-model allowance, provider
   * credit exhaustion) rather than a short throttle. Like `retryable` this is
   * a property of a rate_limited failure, not a separate kind, so callers that
   * already switch on `kind` keep working.
   */
  quotaExhausted?: boolean;
}

export type ChatOutcome = ChatResult | ChatFailure;

export interface ProviderSettings {
  /** Human-readable name used in logs and status output. */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  /** Extra request headers (OpenRouter attribution headers). */
  headers?: Record<string, string>;
  /**
   * Patterns that mark a 429 as a hard quota rather than a transient throttle.
   * A matched body means retrying inside the same run is pointless.
   */
  quotaPatterns: RegExp[];
}

export class OpenAiCompatibleClient {
  private readonly settings: () => ProviderSettings;

  public constructor(settings: () => ProviderSettings) {
    this.settings = settings;
  }

  public isConfigured(): boolean {
    return this.settings().apiKey.trim().length > 0;
  }

  public status(): { configured: boolean; model: string; baseUrl: string; name: string } {
    const s = this.settings();
    return { configured: this.isConfigured(), model: s.model, baseUrl: s.baseUrl, name: s.name };
  }

  public async listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const s = this.settings();
    if (!s.apiKey.trim()) return { ok: false, models: [], error: `${s.name} API key not configured` };
    try {
      const res = await this.fetchWithTimeout(`${s.baseUrl}/models`, {
        method: 'GET',
        headers: this.authHeaders(s),
      }, 30000);
      if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
      const fromData = (body.data ?? []).map((m) => m.id ?? '');
      const fromModels = (body.models ?? []).map((m) => (m.name ?? '').replace(/^models\//, ''));
      return { ok: true, models: [...fromData, ...fromModels].filter(Boolean) };
    } catch (err) {
      return { ok: false, models: [], error: redact(err instanceof Error ? err.message : String(err)) };
    }
  }

  public async chat(options: ChatOptions): Promise<ChatOutcome> {
    const s = this.settings();
    if (!s.apiKey.trim()) {
      return {
        ok: false,
        kind: 'not_configured',
        message: `${s.name} API key is not configured on the server.`,
        retryable: false,
      };
    }

    const model = options.model ?? s.model;
    const maxRetries = Math.max(0, s.maxRetries);
    let lastFailure: ChatFailure | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const outcome = await this.attemptChat(s, options, model);
      if (outcome.ok) return outcome;
      lastFailure = outcome;

      if (outcome.kind === 'aborted' || !outcome.retryable || attempt === maxRetries) break;

      const exponential = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      const backoffMs = Math.max(exponential, outcome.retryAfterMs ?? 0);
      logger.warn('provider retry', { provider: s.name, attempt: attempt + 1, kind: outcome.kind, status: outcome.status, backoffMs });
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    return lastFailure ?? { ok: false, kind: 'network_error', message: 'unknown failure', retryable: false };
  }

  private authHeaders(s: ProviderSettings): Record<string, string> {
    return { Authorization: `Bearer ${s.apiKey}`, ...(s.headers ?? {}) };
  }

  private async attemptChat(s: ProviderSettings, options: ChatOptions, model: string): Promise<ChatOutcome> {
    const timeoutMs = options.timeoutMs ?? s.timeoutMs;
    const body: Record<string, unknown> = {
      model,
      messages: options.messages,
      temperature: options.temperature ?? 0.2,
    };
    if (options.maxTokens) body.max_tokens = options.maxTokens;
    if (options.responseFormatJson) body.response_format = { type: 'json_object' };

    let res: Response;
    try {
      res = await this.fetchWithTimeout(
        `${s.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.authHeaders(s) },
          body: JSON.stringify(body),
        },
        timeoutMs,
        options.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message)) {
        return { ok: false, kind: 'aborted', message: 'request aborted', retryable: false };
      }
      if (/timeout|ETIMEDOUT/i.test(message)) {
        return { ok: false, kind: 'timeout', message: `request timed out after ${timeoutMs}ms`, retryable: true };
      }
      return { ok: false, kind: 'network_error', message: redact(message), retryable: true };
    }

    if (res.status === 429) return this.mapRateLimit(s, res);

    if (res.status === 402) {
      return { ok: false, kind: 'model_unavailable', message: 'insufficient credits for this model', status: 402, retryable: false };
    }
    if (res.status === 404) {
      return { ok: false, kind: 'model_unavailable', message: `model "${model}" not available on ${s.name}`, status: 404, retryable: false };
    }
    // Authentication and request errors are configuration problems, not limits.
    // Reporting them as such keeps the router from silently hiding a bad key.
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        kind: 'http_error',
        message: `${s.name} rejected the credentials (HTTP ${res.status}): ${redact(text).slice(0, 300)}`,
        status: res.status,
        retryable: false,
      };
    }
    if (res.status === 400) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        kind: 'http_error',
        message: `${s.name} rejected the request (HTTP 400): ${redact(text).slice(0, 300)}`,
        status: 400,
        retryable: false,
      };
    }
    if (res.status >= 500) {
      return { ok: false, kind: 'http_error', message: `${s.name} server error HTTP ${res.status}`, status: res.status, retryable: true };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        kind: 'http_error',
        message: `HTTP ${res.status}: ${redact(text).slice(0, 500)}`,
        status: res.status,
        retryable: false,
      };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, kind: 'invalid_response', message: 'response was not valid JSON', retryable: true };
    }

    const parsed = payload as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      model?: string;
      error?: { message?: string; code?: number };
    };

    if (parsed.error) {
      return {
        ok: false,
        kind: 'model_unavailable',
        message: redact(parsed.error.message ?? 'provider error'),
        status: parsed.error.code,
        retryable: false,
      };
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, kind: 'invalid_response', message: 'completion contained no text content', retryable: true };
    }

    return {
      ok: true,
      content,
      model: parsed.model ?? model,
      usage: {
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
        totalTokens: parsed.usage?.total_tokens ?? 0,
      },
      raw: payload,
    };
  }

  /**
   * Distinguishes a temporary throttle from an exhausted quota. Providers
   * signal both with 429; only the first is worth retrying, and only a real
   * quota should take the provider out of the rotation for a while.
   */
  private async mapRateLimit(s: ProviderSettings, res: Response): Promise<ChatFailure> {
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;

    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }

    const hardQuota = s.quotaPatterns.some((re) => re.test(text)) || /quota|exhausted|RESOURCE_EXHAUSTED/i.test(text);

    if (hardQuota) {
      const resetHeader = res.headers.get('x-ratelimit-reset') ?? res.headers.get('x-ratelimit-reset-requests');
      const resetMs = Number(resetHeader);
      const resetIso = Number.isFinite(resetMs) && resetMs > 0
        ? new Date(resetMs > 1e12 ? resetMs : resetMs * 1000).toISOString()
        : null;
      // OpenRouter's daily free-model allowance is the case operators hit most,
      // and it is named explicitly so the message is actionable.
      const daily = /free-models-per-day/i.test(text) || /openrouter_free_tier_daily/i.test(text);
      const label = daily ? 'daily free-model quota exhausted' : 'quota exhausted';
      // The reset instant is surfaced as retryAfterMs so the router can keep
      // the provider out of rotation until the quota actually returns, without
      // this failure being retried inside the current run.
      const resetAtMs = Number.isFinite(resetMs) && resetMs > 0 ? (resetMs > 1e12 ? resetMs : resetMs * 1000) : null;
      return {
        ok: false,
        kind: 'rate_limited',
        message: daily ? `${label}${resetIso ? `; resets at ${resetIso}` : ''}` : `${s.name} ${label}${resetIso ? `; resets at ${resetIso}` : ''}`,
        status: 429,
        retryable: false,
        quotaExhausted: true,
        retryAfterMs: resetAtMs ? Math.max(resetAtMs - Date.now(), 0) : undefined,
      };
    }

    return {
      ok: false,
      kind: 'rate_limited',
      message: retryAfterMs ? `rate limited by ${s.name} (retry after ${retryAfterMs}ms)` : `rate limited by ${s.name}`,
      status: 429,
      retryable: true,
      retryAfterMs,
    };
  }

  // The timer must outlive the response body read. `fetch()` resolves as soon
  // as the headers arrive, so clearing the timer in a `finally` around the fetch
  // call leaves the body download unbounded: a provider that sends headers and
  // then stalls the stream hangs the caller forever. The caller therefore gets a
  // response whose body is already buffered, and only then is the timer cleared.
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onExternalAbort = (): void => controller.abort(new Error('aborted'));
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    };
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const body = await res.arrayBuffer();
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    } finally {
      cleanup();
    }
  }
}
