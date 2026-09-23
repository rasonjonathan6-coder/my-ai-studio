/**
 * AI provider router.
 *
 * One agent, three interchangeable model transports. The router picks a
 * provider for a run and, when that provider reports a *temporary* limit or
 * outage, moves to the next one. A configuration error (bad key, malformed
 * request) is surfaced instead of being masked by a blind failover, so an
 * operator can see the real cause.
 *
 * State kept here is deliberately small and non-sensitive: provider names,
 * cooldown deadlines and the last failure kind. No key ever reaches this layer.
 */
import { config } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import { gemini } from './gemini.ts';
import { groq } from './groq.ts';
import { openRouter } from './openrouter.ts';
import type { ChatFailure, ChatOptions, ChatOutcome } from './providerClient.ts';

export type ProviderId = 'openrouter' | 'gemini' | 'groq';
export type ProviderSelection = 'auto' | ProviderId;

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  isConfigured(): boolean;
  status(): { configured: boolean; model: string; baseUrl: string };
  listModels(): Promise<{ ok: boolean; models: string[]; error?: string }>;
  chat(options: ChatOptions): Promise<ChatOutcome>;
}

function wrap(id: ProviderId, label: string, svc: {
  isConfigured(): boolean;
  status(): { configured: boolean; model: string; baseUrl: string };
  listModels(): Promise<{ ok: boolean; models: string[]; error?: string }>;
  chat(options: ChatOptions): Promise<ChatOutcome>;
}): ProviderAdapter {
  // Methods live on the class prototype, so they are bound explicitly rather
  // than spread: a spread would produce an object with no callable methods.
  return {
    id,
    label,
    isConfigured: () => svc.isConfigured(),
    status: () => svc.status(),
    listModels: () => svc.listModels(),
    chat: (options) => svc.chat(options),
  };
}

const adapters: Record<ProviderId, ProviderAdapter> = {
  openrouter: wrap('openrouter', 'OpenRouter', openRouter),
  gemini: wrap('gemini', 'Google Gemini', gemini),
  groq: wrap('groq', 'Groq', groq),
};

export const PROVIDER_IDS: ProviderId[] = ['openrouter', 'gemini', 'groq'];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

export function isProviderSelection(value: unknown): value is ProviderSelection {
  return value === 'auto' || isProviderId(value);
}

interface CooldownEntry {
  until: number;
  reason: string;
}

export interface AttemptRecord {
  provider: ProviderId;
  model: string;
  endpoint: string;
  outcome: 'ok' | 'fallback' | 'error';
  status?: number;
  kind?: ChatFailure['kind'];
  message?: string;
  at: string;
}

export interface RoutedResult extends Extract<ChatOutcome, { ok: true }> {
  provider: ProviderId;
  providerLabel: string;
  /** Providers tried before this one succeeded, oldest first. */
  attempts: AttemptRecord[];
  /** Set when the run started on a different provider than it finished on. */
  failoverFrom: ProviderId | null;
}

export interface RoutedFailure {
  ok: false;
  provider: ProviderId | null;
  providerLabel: string | null;
  kind: ChatFailure['kind'];
  message: string;
  /** True only when retrying the same request could plausibly succeed. */
  retryable: boolean;
  /** True when the failure was a hard quota rather than a short throttle. */
  quotaExhausted: boolean;
  attempts: AttemptRecord[];
}

export type RoutedOutcome = RoutedResult | RoutedFailure;

/**
 * Failures that mean "this provider cannot answer right now", where trying the
 * next configured provider is worthwhile. A bad key or a malformed request is
 * *not* in here: those must surface to the caller instead of being masked by a
 * failover that would make every provider look broken.
 */
function isTransientFailure(failure: ChatFailure): boolean {
  if (failure.kind === 'not_configured') return false;
  if (failure.kind === 'http_error' && failure.status !== undefined) {
    // 400/401/403 are request or credential problems, not availability.
    return failure.status >= 500 || failure.status === 429;
  }
  return true;
}

export class AiProviderRouter {
  private readonly cooldowns = new Map<ProviderId, CooldownEntry>();
  private readonly history: AttemptRecord[] = [];
  private readonly maxHistory = 100;

  public providers(): ProviderAdapter[] {
    return PROVIDER_IDS.map((id) => adapters[id]);
  }

  public adapter(id: ProviderId): ProviderAdapter {
    return adapters[id];
  }

  public isCooling(id: ProviderId, now = Date.now()): boolean {
    const entry = this.cooldowns.get(id);
    if (!entry) return false;
    if (entry.until <= now) {
      this.cooldowns.delete(id);
      return false;
    }
    return true;
  }

  public cooldownState(): Record<ProviderId, { cooling: boolean; until: string | null; reason: string | null }> {
    const now = Date.now();
    const out = {} as Record<ProviderId, { cooling: boolean; until: string | null; reason: string | null }>;
    for (const id of PROVIDER_IDS) {
      const entry = this.cooldowns.get(id);
      const active = !!entry && entry.until > now;
      out[id] = {
        cooling: active,
        until: active && entry ? new Date(entry.until).toISOString() : null,
        reason: active && entry ? entry.reason : null,
      };
    }
    return out;
  }

  public clearCooldown(id?: ProviderId): void {
    if (id) this.cooldowns.delete(id);
    else this.cooldowns.clear();
  }

  /**
   * Records a failure observed outside a routed call, such as the provider test
   * endpoint. A hard quota must land in the same cooldown the router uses, or a
   * probe would report an exhausted provider while AUTO kept sending runs to it.
   */
  public noteFailure(id: ProviderId, failure: ChatFailure): void {
    if (failure.kind === 'not_configured') return;
    this.enterCooldown(id, failure);
  }

  /** Order in which AUTO will try providers, honouring cooldowns. */
  public autoOrder(now = Date.now()): { ready: ProviderId[]; cooling: ProviderId[]; unconfigured: ProviderId[] } {
    const ready: ProviderId[] = [];
    const cooling: ProviderId[] = [];
    const unconfigured: ProviderId[] = [];
    const order = this.normalizedOrder();
    for (const id of order) {
      if (!adapters[id].isConfigured()) unconfigured.push(id);
      else if (this.isCooling(id, now)) cooling.push(id);
      else ready.push(id);
    }
    return { ready, cooling, unconfigured };
  }

  /** Configured order, de-duplicated, with unknown ids dropped. */
  private normalizedOrder(): ProviderId[] {
    const seen = new Set<ProviderId>();
    const order: ProviderId[] = [];
    for (const raw of config.aiProviderOrder) {
      if (isProviderId(raw) && !seen.has(raw)) {
        seen.add(raw);
        order.push(raw);
      }
    }
    for (const id of PROVIDER_IDS) if (!seen.has(id)) order.push(id);
    return order;
  }

  public recentAttempts(limit = 20): AttemptRecord[] {
    return this.history.slice(-limit);
  }

  /**
   * Runs a chat request through the selected provider.
   *
   * `selection` is 'auto' to walk the ordered list, or a provider id to pin the
   * request. A pinned provider is still reported honestly on failure - the
   * caller sees the real error rather than a silent switch to another vendor.
   */
  public async chat(
    selection: ProviderSelection,
    options: ChatOptions,
    onAttempt?: (record: AttemptRecord) => void,
  ): Promise<RoutedOutcome> {
    const attempts: AttemptRecord[] = [];

    if (selection !== 'auto') {
      const adapter = adapters[selection];
      if (!adapter.isConfigured()) {
        return {
          ok: false,
          provider: selection,
          providerLabel: adapter.label,
          kind: 'not_configured',
          message: `${adapter.label} is selected but its API key is not configured on the server.`,
          retryable: false,
          quotaExhausted: false,
          attempts,
        };
      }
      const outcome = await adapter.chat(options);
      const record = this.record(attempts, adapter, outcome);
      onAttempt?.(record);
      if (outcome.ok) {
        return {
          ...outcome,
          provider: adapter.id,
          providerLabel: adapter.label,
          attempts,
          failoverFrom: null,
        };
      }
      return {
        ok: false,
        provider: adapter.id,
        providerLabel: adapter.label,
        kind: outcome.kind,
        message: outcome.message,
        retryable: outcome.retryable,
        quotaExhausted: outcome.quotaExhausted === true,
        attempts,
      };
    }

    const { ready } = this.autoOrder();
    if (ready.length === 0) {
      const { cooling, unconfigured } = this.autoOrder();
      const detail = unconfigured.length === PROVIDER_IDS.length
        ? 'no provider API key is configured on the server'
        : `all configured providers are cooling down (${cooling.join(', ')})`;
      return {
        ok: false, provider: null, providerLabel: null, kind: 'not_configured',
        message: `AUTO mode: ${detail}`, retryable: false, quotaExhausted: false, attempts,
      };
    }

    let firstTried: ProviderId | null = null;
    let lastFailure: RoutedFailure | null = null;

    for (const id of ready) {
      const adapter = adapters[id];
      firstTried ??= id;
      const outcome = await adapter.chat(options);
      const record = this.record(attempts, adapter, outcome);
      onAttempt?.(record);

      if (outcome.ok) {
        return {
          ...outcome,
          provider: adapter.id,
          providerLabel: adapter.label,
          attempts,
          failoverFrom: firstTried !== adapter.id ? firstTried : null,
        };
      }

      lastFailure = {
        ok: false,
        provider: adapter.id,
        providerLabel: adapter.label,
        kind: outcome.kind,
        message: outcome.message,
        retryable: outcome.retryable,
        quotaExhausted: outcome.quotaExhausted === true,
        attempts,
      };

      // A configuration error is the caller's problem to see, not a reason to
      // burn the remaining providers on the same malformed request.
      if (!isTransientFailure(outcome)) break;

      this.enterCooldown(adapter.id, outcome);
      logger.warn('ai provider failover', { from: adapter.id, kind: outcome.kind, status: outcome.status, next: ready[ready.indexOf(id) + 1] ?? null });
    }

    return lastFailure ?? {
      ok: false, provider: null, providerLabel: null, kind: 'network_error',
      message: 'no provider produced a response', retryable: true, quotaExhausted: false, attempts,
    };
  }

  private enterCooldown(id: ProviderId, failure: ChatFailure): void {
    // Honour a provider's own Retry-After when it gives one, otherwise use the
    // configured cooldown. A hard quota waits for the configured cooldown too,
    // since the exact reset instant is not always exposed.
    const ms = Math.max(config.aiProviderCooldownMs, failure.retryAfterMs ?? 0);
    this.cooldowns.set(id, { until: Date.now() + ms, reason: `${failure.kind}: ${failure.message}`.slice(0, 300) });
  }

  private record(attempts: AttemptRecord[], adapter: ProviderAdapter, outcome: ChatOutcome): AttemptRecord {
    const status = adapter.status();
    const record: AttemptRecord = {
      provider: adapter.id,
      model: outcome.ok ? outcome.model : status.model,
      endpoint: status.baseUrl,
      outcome: outcome.ok ? 'ok' : isTransientFailure(outcome) ? 'fallback' : 'error',
      status: outcome.ok ? 200 : outcome.status,
      kind: outcome.ok ? undefined : outcome.kind,
      message: outcome.ok ? undefined : outcome.message,
      at: new Date().toISOString(),
    };
    attempts.push(record);
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    return record;
  }
}

export const aiRouter = new AiProviderRouter();
