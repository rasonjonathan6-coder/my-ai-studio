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
  /** Rate-limit headers the provider actually returned, or null when absent. */
  rateLimit: RateLimitInfo | null;
  raw: unknown;
}

/**
 * What a provider told us about its own limits. Every field is null when the
 * provider did not send the header: an unknown value stays unknown rather than
 * being defaulted to something plausible.
 */
export interface RateLimitInfo {
  limitRequests: number | null;
  remainingRequests: number | null;
  limitTokens: number | null;
  remainingTokens: number | null;
  resetRequestsAt: string | null;
  resetTokensAt: string | null;
  retryAfterAt: string | null;
}

export interface ChatFailure {
  ok: false;
  kind: 'not_configured' | 'timeout' | 'rate_limited' | 'http_error' | 'invalid_response' | 'network_error' | 'model_unavailable' | 'aborted';
  message: string;
  status?: number;
  retryable: boolean;
  retryAfterMs?: number;
  /**
   * Coarse classification of the failure for operators and the UI. Additive
   * alongside `kind` so existing switches keep working; it separates an
   * exhausted quota from an auth problem, which are otherwise both 4xx.
   */
  classification?: FailureClass;
  /**
   * True when a 429 was a hard quota (daily free-model allowance, provider
   * credit exhaustion) rather than a short throttle. Like `retryable` this is
   * a property of a rate_limited failure, not a separate kind, so callers that
   * already switch on `kind` keep working.
   */
  quotaExhausted?: boolean;
}

export type FailureClass =
  | 'QUOTA_RATE_LIMIT'
  | 'AUTHENTICATION'
  | 'PERMISSION'
  | 'BAD_REQUEST'
  | 'TEMPORARY_FAILURE'
  | 'MODEL_UNAVAILABLE'
  | 'NOT_CONFIGURED';

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
  /**
   * False for a local runtime (Ollama, vLLM), where the absence of an API key
   * is normal. Configuration is then decided by whether a base URL is set.
   */
  requiresApiKey?: boolean;
  /** What the provider can be trusted to do for the agent. */
  capabilities?: ProviderCapabilities;
}

/**
 * Honest description of a provider's agent support. A provider that only knows
 * plain chat is labelled CHAT_ONLY rather than presented as a full OpenHands
 * backend, because the agent drives its tools through structured JSON replies.
 */
export interface ProviderCapabilities {
  /** Follows the agent's text JSON tool protocol. */
  agent: boolean;
  chat: boolean;
  streaming: boolean;
  jsonMode: boolean;
  /** Set when agent support is partial, with the reason shown to operators. */
  agentNote?: string;
}

export class OpenAiCompatibleClient {
  private readonly settings: () => ProviderSettings;

  public constructor(settings: () => ProviderSettings) {
    this.settings = settings;
  }

  public isConfigured(): boolean {
    const s = this.settings();
    // A local runtime has no key by design; its base URL is what must be set.
    if (s.requiresApiKey === false) return s.baseUrl.trim().length > 0;
    return s.apiKey.trim().length > 0;
  }

  public status(): { configured: boolean; model: string; baseUrl: string; name: string } {
    const s = this.settings();
    return { configured: this.isConfigured(), model: s.model, baseUrl: s.baseUrl, name: s.name };
  }

  /** Capabilities as declared by the provider wrapper. */
  public capabilities(): ProviderCapabilities {
    return this.settings().capabilities ?? { agent: true, chat: true, streaming: false, jsonMode: false };
  }

  /**
   * Reads the rate-limit headers a provider actually sent. Providers differ in
   * naming, so both the OpenAI (`x-ratelimit-*`) and the older variants are
   * checked. A missing header yields null and is never guessed at.
   */
  private static parseRateLimit(headers: Headers): RateLimitInfo {
    const num = (name: string): number | null => {
      const raw = headers.get(name);
      if (raw === null || raw.trim() === '') return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    // Reset values are durations in some APIs and epochs in others. A value
    // large enough to be an epoch millisecond is treated as one; small values
    // are treated as seconds from now. Anything else stays null.
    const instant = (name: string): string | null => {
      const n = num(name);
      if (n === null || n <= 0) return null;
      const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : Date.now() + n * 1000;
      return new Date(ms).toISOString();
    };
    return {
      limitRequests: num('x-ratelimit-limit-requests'),
      remainingRequests: num('x-ratelimit-remaining-requests'),
      limitTokens: num('x-ratelimit-limit-tokens'),
      remainingTokens: num('x-ratelimit-remaining-tokens'),
      resetRequestsAt: instant('x-ratelimit-reset-requests'),
      resetTokensAt: instant('x-ratelimit-reset-tokens'),
      retryAfterAt: instant('retry-after'),
    };
  }

  public async listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const s = this.settings();
    if (!this.isConfigured()) return { ok: false, models: [], error: `${s.name} is not configured` };
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
    if (!this.isConfigured()) {
      return {
        ok: false,
        kind: 'not_configured',
        message: s.requiresApiKey === false
          ? `${s.name} has no base URL configured on the server.`
          : `${s.name} API key is not configured on the server.`,
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
        return { ok: false, kind: 'aborted', message: 'request aborted', retryable: false, classification: 'BAD_REQUEST' };
      }
      if (/timeout|ETIMEDOUT/i.test(message)) {
        return { ok: false, kind: 'timeout', message: `request timed out after ${timeoutMs}ms`, retryable: true, classification: 'TEMPORARY_FAILURE' };
      }
      return { ok: false, kind: 'network_error', message: redact(message), retryable: true, classification: 'TEMPORARY_FAILURE' };
    }

    if (res.status === 429) return this.mapRateLimit(s, res);

    if (res.status === 402) {
      return { ok: false, kind: 'model_unavailable', message: 'insufficient credits for this model', status: 402, retryable: false, classification: 'QUOTA_RATE_LIMIT' };
    }
    if (res.status === 404) {
      return { ok: false, kind: 'model_unavailable', message: `model "${model}" not available on ${s.name}`, status: 404, retryable: false, classification: 'MODEL_UNAVAILABLE' };
    }
    // Authentication and request errors are configuration problems, not limits.
    // Reporting them as such keeps the router from silently hiding a bad key.
    if (res.status === 401) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        kind: 'http_error',
        message: `${s.name} rejected the credentials (HTTP 401): ${redact(text).slice(0, 300)}`,
        status: 401,
        retryable: false,
        classification: 'AUTHENTICATION',
      };
    }
    if (res.status === 403) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        kind: 'http_error',
        message: `${s.name} denied access (HTTP 403): ${redact(text).slice(0, 300)}`,
        status: 403,
        retryable: false,
        classification: 'PERMISSION',
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
        classification: 'BAD_REQUEST',
      };
    }
    if (res.status >= 500) {
      return { ok: false, kind: 'http_error', message: `${s.name} server error HTTP ${res.status}`, status: res.status, retryable: true, classification: 'TEMPORARY_FAILURE' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        kind: 'http_error',
        message: `HTTP ${res.status}: ${redact(text).slice(0, 500)}`,
        status: res.status,
        retryable: false,
        classification: 'BAD_REQUEST',
      };
    }

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, kind: 'invalid_response', message: 'response was not valid JSON', retryable: true, classification: 'TEMPORARY_FAILURE' };
    }

    const parsed = payload as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: unknown[]; refusal?: string | null };
        finish_reason?: string;
      }>;
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

    const choice = parsed.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      // An empty completion is usually a provider quirk (a filtered or
      // truncated choice), so the shape is recorded to make the cause
      // diagnosable from logs instead of guessed at.
      logger.warn('provider returned no text content', {
        provider: s.name,
        model,
        finishReason: choice?.finish_reason ?? null,
        hasToolCalls: Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0,
        refusal: choice?.message?.refusal ?? null,
        choiceCount: parsed.choices?.length ?? 0,
      });
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
      rateLimit: OpenAiCompatibleClient.parseRateLimit(res.headers),
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
        classification: 'QUOTA_RATE_LIMIT',
        retryAfterMs: resetAtMs ? Math.max(resetAtMs - Date.now(), 0) : undefined,
      };
    }

    return {
      ok: false,
      kind: 'rate_limited',
      message: retryAfterMs ? `rate limited by ${s.name} (retry after ${retryAfterMs}ms)` : `rate limited by ${s.name}`,
      status: 429,
      retryable: true,
      classification: 'QUOTA_RATE_LIMIT',
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
