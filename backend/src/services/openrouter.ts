/**
 * OpenRouter integration. Server-side only: the API key is read from the
 * backend environment and never included in any response body, log line or
 * artifact. Callers receive either a real completion or a structured error.
 */
import { config } from '../config/index.ts';
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
}

export type ChatOutcome = ChatResult | ChatFailure;

export class OpenRouterService {
  public isConfigured(): boolean {
    return config.openRouterApiKey.trim().length > 0;
  }

  public status(): { configured: boolean; model: string; baseUrl: string } {
    return { configured: this.isConfigured(), model: config.openRouterModel, baseUrl: config.openRouterBaseUrl };
  }

  public async listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    if (!this.isConfigured()) return { ok: false, models: [], error: 'OPENROUTER_API_KEY not configured' };
    try {
      const res = await this.fetchWithTimeout(`${config.openRouterBaseUrl}/models`, { method: 'GET' }, 30000);
      if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const models = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  public async chat(options: ChatOptions): Promise<ChatOutcome> {
    if (!this.isConfigured()) {
      return {
        ok: false,
        kind: 'not_configured',
        message: 'OPENROUTER_API_KEY is not configured on the server.',
        retryable: false,
      };
    }

    const model = options.model ?? config.openRouterModel;
    const maxRetries = Math.max(0, config.openRouterMaxRetries);
    let lastFailure: ChatFailure | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const outcome = await this.attemptChat(options, model);
      if (outcome.ok) return outcome;
      lastFailure = outcome;

      if (outcome.kind === 'aborted' || !outcome.retryable || attempt === maxRetries) break;

      const exponential = Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      const backoffMs = Math.max(exponential, outcome.retryAfterMs ?? 0);
      logger.warn('openrouter retry', { attempt: attempt + 1, kind: outcome.kind, status: outcome.status, backoffMs });
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    return lastFailure ?? { ok: false, kind: 'network_error', message: 'unknown failure', retryable: false };
  }

  private async attemptChat(options: ChatOptions, model: string): Promise<ChatOutcome> {
    const timeoutMs = options.timeoutMs ?? config.openRouterTimeoutMs;
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
        `${config.openRouterBaseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.openRouterApiKey}`,
            'HTTP-Referer': config.openRouterReferer,
            'X-Title': config.openRouterTitle,
          },
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

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
      let body = '';
      try {
        body = await res.text();
      } catch {
        body = '';
      }
      // A daily free-tier quota is exhausted until a fixed reset timestamp, so
      // retrying within the same run is pointless. Report when it comes back
      // instead of burning attempts against a wall.
      const daily = /free-models-per-day/i.test(body) || /openrouter_free_tier_daily/i.test(body);
      if (daily) {
        const resetHeader = res.headers.get('x-ratelimit-reset');
        const resetMs = Number(resetHeader);
        const resetIso = Number.isFinite(resetMs) && resetMs > 0 ? new Date(resetMs).toISOString() : null;
        return {
          ok: false,
          kind: 'rate_limited',
          message: `daily free-model quota exhausted${resetIso ? `; resets at ${resetIso}` : ''}`,
          status: 429,
          retryable: false,
        };
      }
      return {
        ok: false,
        kind: 'rate_limited',
        message: retryAfterMs ? `rate limited by OpenRouter (retry after ${retryAfterMs}ms)` : 'rate limited by OpenRouter',
        status: 429,
        retryable: true,
        retryAfterMs,
      };
    }
    if (res.status === 402) {
      return { ok: false, kind: 'model_unavailable', message: 'insufficient credits for this model', status: 402, retryable: false };
    }
    if (res.status === 404) {
      return { ok: false, kind: 'model_unavailable', message: `model "${model}" not available`, status: 404, retryable: false };
    }
    if (res.status >= 500) {
      return { ok: false, kind: 'http_error', message: `OpenRouter server error HTTP ${res.status}`, status: res.status, retryable: true };
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

export const openRouter = new OpenRouterService();
