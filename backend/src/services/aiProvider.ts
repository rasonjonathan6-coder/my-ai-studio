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
import {
  cerebras, chutes, cloudflare, huggingface, mistral, nvidia, ollama, sambanova, vllm,
  type ProviderService,
} from './providers.ts';
import type { ChatFailure, ChatOptions, ChatOutcome, ProviderCapabilities } from './providerClient.ts';

/**
 * Every provider the gateway knows about, in the order they are declared here.
 * Declaration order is only the fallback for ids missing from the configured
 * priority list; it is not the effective order of use.
 */
export const PROVIDER_IDS = [
  'openrouter', 'gemini', 'groq', 'cerebras', 'mistral', 'cloudflare',
  'nvidia', 'huggingface', 'chutes', 'sambanova', 'ollama', 'vllm',
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];
export type ProviderSelection = 'auto' | ProviderId;

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  /** True for a locally hosted runtime, shown differently in the UI. */
  local: boolean;
  isConfigured(): boolean;
  status(): { configured: boolean; model: string; baseUrl: string };
  capabilities(): ProviderCapabilities;
  listModels(): Promise<{ ok: boolean; models: string[]; error?: string }>;
  chat(options: ChatOptions): Promise<ChatOutcome>;
}

const SERVICES: Record<ProviderId, ProviderService> = {
  openrouter: openRouter,
  gemini,
  groq,
  cerebras,
  mistral,
  cloudflare,
  nvidia,
  huggingface,
  chutes,
  sambanova,
  ollama,
  vllm,
};

const LABELS: Record<ProviderId, string> = {
  openrouter: 'OpenRouter',
  gemini: 'Google Gemini',
  groq: 'Groq',
  cerebras: 'Cerebras',
  mistral: 'Mistral',
  cloudflare: 'Cloudflare Workers AI',
  nvidia: 'NVIDIA',
  huggingface: 'Hugging Face',
  chutes: 'Chutes',
  sambanova: 'SambaNova',
  ollama: 'Ollama (local)',
  vllm: 'vLLM (local)',
};

const LOCAL: ReadonlySet<ProviderId> = new Set<ProviderId>(['ollama', 'vllm']);

function wrap(id: ProviderId): ProviderAdapter {
  const svc = SERVICES[id];
  // Methods live on the class prototype, so they are bound explicitly rather
  // than spread: a spread would produce an object with no callable methods.
  return {
    id,
    label: LABELS[id],
    local: LOCAL.has(id),
    isConfigured: () => svc.isConfigured(),
    status: () => svc.status(),
    capabilities: () => svc.capabilities(),
    listModels: () => svc.listModels(),
    chat: (options) => svc.chat(options),
  };
}

const adapters = Object.fromEntries(
  PROVIDER_IDS.map((id) => [id, wrap(id)]),
) as Record<ProviderId, ProviderAdapter>;

/**
 * Builds an adapter from any service. Exported so tests can register a mock
 * service and exercise the real routing, cooldown and classification code
 * without sending a request to a real provider.
 */
export function makeAdapter(id: ProviderId, svc: ProviderService): ProviderAdapter {
  return {
    id,
    label: LABELS[id],
    local: LOCAL.has(id),
    isConfigured: () => svc.isConfigured(),
    status: () => svc.status(),
    capabilities: () => svc.capabilities(),
    listModels: () => svc.listModels(),
    chat: (options) => svc.chat(options),
  };
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isProviderSelection(value: unknown): value is ProviderSelection {
  return value === 'auto' || isProviderId(value);
}

interface CooldownEntry {
  until: number;
  reason: string;
  /** How many consecutive limit hits led here; drives the escalating backoff. */
  strike: number;
}

/**
 * The live state the gateway holds for a provider. Everything here comes from
 * something actually observed: a real request outcome, a real response header,
 * or the configuration. Nothing is estimated, and every unknown is null.
 */
export interface ProviderState {
  id: ProviderId;
  label: string;
  local: boolean;
  configured: boolean;
  /** True once a real request has succeeded; configuration alone proves nothing. */
  available: boolean;
  lastStatusCode: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  cooldownStrike: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  /** Rate-limit headers the provider itself returned, or null when never seen. */
  rateLimitRemainingRequests: number | null;
  rateLimitRemainingTokens: number | null;
  rateLimitResetAt: string | null;
  capabilities: ProviderCapabilities;
}

/** Requests the router itself observed for a provider on a given day. */
export interface RequestCounter {
  date: string;
  attempts: number;
  ok: number;
  failed: number;
}

export interface AttemptRecord {
  provider: ProviderId;
  model: string;
  endpoint: string;
  outcome: 'ok' | 'fallback' | 'error';
  status?: number;
  kind?: ChatFailure['kind'];
  classification?: ChatFailure['classification'];
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
  // An auth/permission/bad-request classification is configuration, not load.
  if (failure.classification === 'AUTHENTICATION' || failure.classification === 'PERMISSION' || failure.classification === 'BAD_REQUEST') {
    return false;
  }
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
  private readonly counters = new Map<ProviderId, RequestCounter>();
  /**
   * Adapter table. Production uses the real ones; a test passes a partial
   * override so the routing and cooldown logic runs against mock services.
   */
  private readonly table: Record<ProviderId, ProviderAdapter>;

  public constructor(overrides: Partial<Record<ProviderId, ProviderAdapter>> = {}) {
    this.table = { ...adapters, ...overrides };
  }
  /** Per-provider observations that outlive a single day: last status, headers. */
  private readonly observed = new Map<ProviderId, {
    available: boolean;
    lastStatusCode: number | null;
    lastError: string | null;
    lastErrorAt: string | null;
    rateLimitRemainingRequests: number | null;
    rateLimitRemainingTokens: number | null;
    rateLimitResetAt: string | null;
  }>();

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private observation(id: ProviderId) {
    const cur = this.observed.get(id);
    if (cur) return cur;
    const fresh = {
      available: false,
      lastStatusCode: null,
      lastError: null,
      lastErrorAt: null,
      rateLimitRemainingRequests: null,
      rateLimitRemainingTokens: null,
      rateLimitResetAt: null,
    };
    this.observed.set(id, fresh);
    return fresh;
  }

  private countAttempt(id: ProviderId, ok: boolean): void {
    const date = this.today();
    const cur = this.counters.get(id);
    if (!cur || cur.date !== date) {
      this.counters.set(id, { date, attempts: 1, ok: ok ? 1 : 0, failed: ok ? 0 : 1 });
      return;
    }
    cur.attempts += 1;
    if (ok) cur.ok += 1;
    else cur.failed += 1;
  }

  /**
   * Requests this process actually sent per provider today. The provider APIs
   * do not expose a remaining-quota figure, so callers must present these as
   * observed counts and label the remaining quota as unknown.
   */
  public requestCounters(): Record<ProviderId, RequestCounter> {
    const date = this.today();
    const out = {} as Record<ProviderId, RequestCounter>;
    for (const id of PROVIDER_IDS) {
      const cur = this.counters.get(id);
      out[id] = cur && cur.date === date ? { ...cur } : { date, attempts: 0, ok: 0, failed: 0 };
    }
    return out;
  }

  public providers(): ProviderAdapter[] {
    return PROVIDER_IDS.map((id) => this.table[id]);
  }

  public adapter(id: ProviderId): ProviderAdapter {
    return this.table[id];
  }

  public isCooling(id: ProviderId, now = Date.now()): boolean {
    const entry = this.cooldowns.get(id);
    if (!entry) return false;
    if (entry.until <= now) {
      // The entry is kept (not deleted) so the strike count survives, which is
      // what makes a repeated offender back off further next time.
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
   * Full per-provider state for the UI. Configuration and observed counters come
   * from this process; anything the provider never told us stays null.
   */
  public providerStates(): ProviderState[] {
    const cooldowns = this.cooldownState();
    const counters = this.requestCounters();
    return PROVIDER_IDS.map((id) => {
      const adapter = this.table[id];
      const status = adapter.status();
      const obs = this.observation(id);
      const count = counters[id];
      const entry = this.cooldowns.get(id);
      return {
        id,
        label: adapter.label,
        local: adapter.local,
        configured: status.configured,
        available: obs.available,
        lastStatusCode: obs.lastStatusCode,
        lastError: obs.lastError,
        lastErrorAt: obs.lastErrorAt,
        cooldownUntil: cooldowns[id].until,
        cooldownReason: cooldowns[id].reason,
        cooldownStrike: entry ? entry.strike : 0,
        requestCount: count.attempts,
        successCount: count.ok,
        failureCount: count.failed,
        rateLimitRemainingRequests: obs.rateLimitRemainingRequests,
        rateLimitRemainingTokens: obs.rateLimitRemainingTokens,
        rateLimitResetAt: obs.rateLimitResetAt,
        capabilities: adapter.capabilities(),
      };
    });
  }

  /**
   * Records a real success, including the rate-limit headers the provider sent.
   * `available` flips to true only here: a key being present is not proof that
   * the provider answers.
   */
  private noteSuccess(id: ProviderId, result: Extract<ChatOutcome, { ok: true }>): void {
    const obs = this.observation(id);
    obs.available = true;
    obs.lastStatusCode = 200;
    obs.lastError = null;
    obs.lastErrorAt = null;
    // Recovery clears the backoff ladder so the next isolated limit starts over.
    this.cooldowns.delete(id);
    const rl = result.rateLimit;
    if (rl) {
      if (rl.remainingRequests !== null) obs.rateLimitRemainingRequests = rl.remainingRequests;
      if (rl.remainingTokens !== null) obs.rateLimitRemainingTokens = rl.remainingTokens;
      const reset = rl.resetRequestsAt ?? rl.resetTokensAt ?? rl.retryAfterAt;
      if (reset) obs.rateLimitResetAt = reset;
    }
  }

  /** Records a real failure. The message is already redacted by the client. */
  private noteObservedFailure(id: ProviderId, failure: ChatFailure): void {
    const obs = this.observation(id);
    obs.lastStatusCode = failure.status ?? null;
    obs.lastError = `${failure.classification ?? failure.kind}: ${failure.message}`.slice(0, 500);
    obs.lastErrorAt = new Date().toISOString();
  }

  /**
   * Records a success observed outside a routed call, such as the provider test
   * endpoint. It is counted like any other real request, so the counters stay a
   * truthful tally of what this process sent.
   */
  public noteTest(id: ProviderId, result: Extract<ChatOutcome, { ok: true }>): void {
    this.countAttempt(id, true);
    this.noteSuccess(id, result);
  }

  /** Records a failure observed outside a routed call, such as the test endpoint. */
  public noteFailure(id: ProviderId, failure: ChatFailure): void {
    if (failure.kind !== 'not_configured') this.countAttempt(id, false);
    this.noteObservedFailure(id, failure);
    if (failure.kind === 'not_configured') return;
    // Only a limit or an outage should remove a provider from rotation. A bad
    // key is a configuration fault the operator must see, not a busy provider.
    if (!isTransientFailure(failure)) return;
    this.enterCooldown(id, failure);
  }

  /** Order in which AUTO will try providers, honouring cooldowns. */
  public autoOrder(now = Date.now()): { ready: ProviderId[]; cooling: ProviderId[]; unconfigured: ProviderId[] } {
    const ready: ProviderId[] = [];
    const cooling: ProviderId[] = [];
    const unconfigured: ProviderId[] = [];
    const order = this.normalizedOrder();
    for (const id of order) {
      if (!this.table[id].isConfigured()) unconfigured.push(id);
      else if (this.isCooling(id, now)) cooling.push(id);
      else ready.push(id);
    }
    return { ready, cooling, unconfigured };
  }

  /** Configured order, de-duplicated, with unknown ids dropped. */
  private normalizedOrder(): ProviderId[] {
    const seen = new Set<ProviderId>();
    const order: ProviderId[] = [];
    for (const raw of config.aiProviderPriority) {
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
      const adapter = this.table[selection];
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
      // A pinned failure is still a fact about the provider: recording it keeps
      // AUTO from sending the next run at a provider just proven unavailable.
      if (isTransientFailure(outcome)) this.enterCooldown(adapter.id, outcome);
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
      const adapter = this.table[id];
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
    // Strikes escalate the wait so a provider that keeps refusing is not
    // re-tried at the same cadence forever: 30s -> 1m -> 5m -> 15m, capped.
    // A success resets the ladder, so a provider that recovered is trusted.
    const strike = (this.cooldowns.get(id)?.strike ?? 0) + 1;
    const ladder = [config.aiProviderCooldownMs, 60_000, 5 * 60_000, config.aiProviderCooldownMaxMs];
    const base = ladder[Math.min(strike - 1, ladder.length - 1)];
    // A provider's own Retry-After always wins over the ladder, and a hard
    // quota's reset instant is honoured even when it is far away.
    const ms = Math.max(base, failure.retryAfterMs ?? 0);
    this.cooldowns.set(id, {
      until: Date.now() + ms,
      reason: `${failure.classification ?? failure.kind}: ${failure.message}`.slice(0, 300),
      strike,
    });
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
      classification: outcome.ok ? undefined : outcome.classification,
      message: outcome.ok ? undefined : outcome.message,
      at: new Date().toISOString(),
    };
    attempts.push(record);
    this.countAttempt(adapter.id, outcome.ok);
    if (outcome.ok) this.noteSuccess(adapter.id, outcome);
    else this.noteObservedFailure(adapter.id, outcome);
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    return record;
  }
}

export const aiRouter = new AiProviderRouter();
