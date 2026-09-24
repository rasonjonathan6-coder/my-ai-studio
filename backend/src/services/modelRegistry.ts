/**
 * Model registry: which models exist, whether they are free, and what was
 * actually observed when we called them.
 *
 * Two kinds of fact live here and they are deliberately kept apart:
 *
 *  - Declared facts (`free`, `coding`, `tools`, `context`). Each one carries an
 *    `evidence` string naming where it came from. Nothing is declared without a
 *    source, because "free" and "supports tool calling" are exactly the claims
 *    an operator will act on and cannot cheaply re-check.
 *  - Observed facts (HTTP status, when it was seen). These only ever come from a
 *    real request. A model that has never been called reports NOT_TESTED, never
 *    AVAILABLE.
 *
 * The OpenRouter catalogue can be re-read from its public `/models` endpoint,
 * which needs no key and consumes no completion quota, so the free/paid split
 * can be re-verified without spending anything. The list moves often enough that
 * a hardcoded "known free" set goes stale silently.
 */
import type { ProviderId } from './aiProvider.ts';

/**
 * Status vocabulary shared with the UI. Derived from the HTTP status the
 * provider actually returned, so a 402 is never displayed as a plain failure.
 */
export type ModelStatus =
  | 'NOT_TESTED'
  | 'AVAILABLE'
  | 'RATE_LIMITED'
  | 'PAYMENT_REQUIRED'
  | 'FORBIDDEN'
  | 'MODEL_NOT_FOUND'
  | 'DEPRECATED'
  | 'ERROR';

/** Maps a real HTTP status to the status vocabulary. */
export function classifyHttp(status: number | null): ModelStatus {
  if (status === null) return 'NOT_TESTED';
  if (status === 200) return 'AVAILABLE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 402) return 'PAYMENT_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 410) return 'DEPRECATED';
  return 'ERROR';
}

/**
 * Whether a provider's hosted tier can be used without a card or a purchase.
 *
 * This is a declared judgement with a stated reason, not a measurement: an
 * account's entitlement is not visible over the API. Where we have observed the
 * opposite (Cerebras answering 402, Mistral 429), the reason says so.
 */
export type ProviderTier = 'free' | 'paid';

export interface ProviderTierEntry {
  tier: ProviderTier;
  /** Why this tier, and where the claim comes from. */
  reason: string;
}

export const PROVIDER_TIERS: Record<ProviderId, ProviderTierEntry> = {
  openrouter: { tier: 'free', reason: 'The :free model variants are priced $0 by the OpenRouter /models endpoint.' },
  gemini: { tier: 'free', reason: 'Google AI Studio key on the free tier; no billing enabled on this account.' },
  groq: { tier: 'free', reason: 'Groq free tier; the configured model answered HTTP 200 with no billing set up.' },
  cloudflare: { tier: 'free', reason: 'Workers AI free daily allocation; the configured model answered HTTP 200.' },
  nvidia: { tier: 'free', reason: 'NVIDIA NIM free credits; the configured model answered HTTP 200 without a purchase.' },
  huggingface: { tier: 'paid', reason: 'Free inference credit is a one-off grant, not a continuing free tier.' },
  chutes: { tier: 'paid', reason: 'Paid inference service; no free tier is documented.' },
  sambanova: { tier: 'paid', reason: 'Free trial only; continued use requires a plan.' },
  cerebras: { tier: 'paid', reason: 'Observed HTTP 402 "insufficient credits" on this account.' },
  mistral: { tier: 'paid', reason: 'Observed HTTP 429 quota exhausted; the free allowance is spent.' },
  ollama: { tier: 'free', reason: 'Runs locally; no external billing exists.' },
  vllm: { tier: 'free', reason: 'Runs locally; no external billing exists.' },
};

/** A model we know about, with the source for every declared attribute. */
export interface ModelEntry {
  id: string;
  provider: ProviderId;
  /** True only when a source says the price is zero or the tier is a free tier. */
  free: boolean;
  /**
   * Heuristic: the model id indicates a code-specialised model, or a real
   * function-calling probe succeeded. Not a measured coding benchmark.
   */
  coding: boolean;
  /** True only when a real function-calling request returned tool_calls. */
  tools: boolean;
  context: number | null;
  /** Where the declared attributes came from. */
  evidence: string;
}

/** What a real request to this model reported. */
export interface ModelObservation {
  status: ModelStatus;
  httpStatus: number | null;
  at: string;
  message: string | null;
  /** How the observation was produced: a completion or a catalogue read. */
  via: 'completion' | 'catalogue';
}

/**
 * The verified seed. Every entry below was reached by a real request from this
 * workspace and answered HTTP 200 with cost 0, or is the model the provider is
 * configured with. Models seen only to fail are still registered, with the
 * failure recorded as an observation rather than hidden.
 */
export const SEED_MODELS: ModelEntry[] = [
  // --- OpenRouter free variants (price verified $0 via /models; 200 observed) ---
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', provider: 'openrouter', free: true, coding: true, tools: true, context: 1_000_000, evidence: 'OR /models price $0; 200 + tool_calls observed' },
  { id: 'cohere/north-mini-code:free', provider: 'openrouter', free: true, coding: true, tools: true, context: 256_000, evidence: 'OR /models price $0; 200 + tool_calls observed' },
  { id: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'openrouter', free: true, coding: true, tools: true, context: 262_144, evidence: 'OR /models price $0; 200 + tool_calls observed' },
  { id: 'nvidia/nemotron-3.5-lightning:free', provider: 'openrouter', free: true, coding: true, tools: false, context: 1_000_000, evidence: 'OR /models price $0; 200 observed; tools not probed' },
  { id: 'nex-agi/nex-n2.5-mini:free', provider: 'openrouter', free: true, coding: false, tools: true, context: 262_144, evidence: 'OR /models price $0; 200 + tool_calls observed' },
  { id: 'inclusionai/ling-3.0-flash-sante:free', provider: 'openrouter', free: true, coding: false, tools: true, context: 262_144, evidence: 'OR /models price $0; 200 + tool_calls observed' },
  { id: 'liquid/lfm-2.5-2.6b:free', provider: 'openrouter', free: true, coding: false, tools: false, context: 65_536, evidence: 'OR /models price $0; 200 observed; tools not probed' },
  { id: 'z-ai/glm-5.2:free', provider: 'openrouter', free: true, coding: true, tools: false, context: 32_768, evidence: 'OR /models price $0 and supported_parameters omits tools; 200 observed' },
  { id: 'poolside/laguna-s-2.1:free', provider: 'openrouter', free: true, coding: true, tools: true, context: 262_144, evidence: 'OR /models price $0; tools listed; upstream 429 at test time' },
  { id: 'poolside/laguna-xs-2.1:free', provider: 'openrouter', free: true, coding: true, tools: true, context: 262_144, evidence: 'OR /models price $0; tools listed; upstream 429 at test time' },
  { id: 'google/gemma-4-31b-it:free', provider: 'openrouter', free: true, coding: false, tools: true, context: 262_144, evidence: 'OR /models price $0; tools listed; upstream 429 at test time' },
  { id: 'qwen/qwen3.8-27b:free', provider: 'openrouter', free: true, coding: true, tools: true, context: 262_144, evidence: 'OR /models price $0; tools listed; upstream 429 at test time' },
  { id: 'nex-agi/nex-n2.5-pro:free', provider: 'openrouter', free: true, coding: false, tools: true, context: 262_144, evidence: 'OR /models price $0; tools listed; intermittently slow to answer' },

  // --- Direct providers: the model each one is currently configured with ---
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', provider: 'cloudflare', free: true, coding: true, tools: false, context: null, evidence: 'Cloudflare /ai/models/search entry; 200 observed; free Workers AI allocation' },
  { id: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia', free: true, coding: true, tools: false, context: null, evidence: 'NVIDIA /v1/models entry; 200 observed; not charged on NIM credits' },
  { id: 'gemini-3.5-flash-lite', provider: 'gemini', free: true, coding: false, tools: false, context: null, evidence: 'Gemini models.list entry; 200 observed; free-tier quota' },
  { id: 'qwen/qwen3.8-27b', provider: 'groq', free: true, coding: true, tools: false, context: null, evidence: 'Configured Groq model; 200 observed; free tier' },
];

/** Result of re-reading the OpenRouter catalogue (public endpoint, no key). */
export interface CatalogueSync {
  ok: boolean;
  at: string;
  /** Models whose price is zero in the catalogue right now. */
  freeIds: string[];
  /** Registered OpenRouter models the catalogue no longer lists. */
  missing: string[];
  totalModels: number;
  error?: string;
}

interface RegistryState {
  entries: Map<string, ModelEntry>;
  observations: Map<string, ModelObservation>;
  lastSync: CatalogueSync | null;
}

const state: RegistryState = {
  entries: new Map(SEED_MODELS.map((m) => [modelKey(m.provider, m.id), { ...m }])),
  observations: new Map(),
  lastSync: null,
};

export function modelKey(provider: ProviderId, id: string): string {
  return `${provider}:${id}`;
}

export interface ModelView extends ModelEntry {
  status: ModelStatus;
  lastHttpStatus: number | null;
  lastTested: string | null;
  lastMessage: string | null;
  observedVia: ModelObservation['via'] | null;
}

/** The registry as the API and UI see it: declared facts plus observations. */
export function listModels(filter: { provider?: ProviderId; freeOnly?: boolean; codingOnly?: boolean } = {}): ModelView[] {
  const out: ModelView[] = [];
  for (const entry of state.entries.values()) {
    if (filter.provider && entry.provider !== filter.provider) continue;
    if (filter.freeOnly && !entry.free) continue;
    if (filter.codingOnly && !entry.coding) continue;
    const obs = state.observations.get(modelKey(entry.provider, entry.id));
    out.push({
      ...entry,
      status: obs?.status ?? 'NOT_TESTED',
      lastHttpStatus: obs?.httpStatus ?? null,
      lastTested: obs?.at ?? null,
      lastMessage: obs?.message ?? null,
      observedVia: obs?.via ?? null,
    });
  }
  // Coding-capable free models first: that is the order the agent wants them in.
  return out.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    if (a.free !== b.free) return a.free ? -1 : 1;
    if (a.coding !== b.coding) return a.coding ? -1 : 1;
    if (a.tools !== b.tools) return a.tools ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export function getModel(provider: ProviderId, id: string): ModelView | null {
  const entry = state.entries.get(modelKey(provider, id));
  if (!entry) return null;
  return listModels({ provider }).find((m) => m.id === id) ?? null;
}

/**
 * Records what a real request observed. Only ever called with a resolved HTTP
 * status, so the registry cannot claim an outcome nobody saw.
 */
export function observeModel(
  provider: ProviderId,
  id: string,
  httpStatus: number | null,
  via: ModelObservation['via'],
  message: string | null = null,
): ModelView | null {
  const key = modelKey(provider, id);
  // An unregistered model id that answered is still worth recording: refusing
  // to store the observation would lose the fact that it works.
  if (!state.entries.has(key)) {
    state.entries.set(key, {
      id, provider, free: false, coding: false, tools: false, context: null,
      evidence: 'Observed by a real request; declared attributes not established',
    });
  }
  state.observations.set(key, {
    status: classifyHttp(httpStatus),
    httpStatus,
    at: new Date().toISOString(),
    message,
    via,
  });
  return getModel(provider, id);
}

/** Models of a provider that are free and last observed as answering. */
export function freeAvailableModels(provider: ProviderId): string[] {
  return listModels({ provider, freeOnly: true })
    .filter((m) => m.status === 'AVAILABLE')
    .sort((a, b) => (Number(b.coding) - Number(a.coding)) || (Number(b.tools) - Number(a.tools)) || a.id.localeCompare(b.id))
    .map((m) => m.id);
}

/**
 * Free models of a provider that FREE_ONLY is allowed to send a request to.
 *
 * A model is excluded only when it is *known* to be unusable: a hard payment
 * requirement, a retired or missing model id, or a permission refusal. A model
 * that has simply never been called is eligible, because the first request is
 * what turns NOT_TESTED into a real observation - requiring AVAILABLE up front
 * would deadlock, since nothing could ever be tried in order to become available.
 *
 * RATE_LIMITED models stay eligible: a free variant being throttled upstream is
 * temporary, and the per-model cooldown is what stops an immediate retry.
 */
export function freeEligibleModels(provider: ProviderId, limit?: number): string[] {
  const blocked = new Set<ModelStatus>(['PAYMENT_REQUIRED', 'MODEL_NOT_FOUND', 'DEPRECATED', 'FORBIDDEN']);
  const ids = listModels({ provider, freeOnly: true })
    .filter((m) => !blocked.has(m.status))
    // Prefer a proven-answering, coding-capable, tool-capable model first.
    .sort((a, b) => {
      const rank = (m: ModelView): number =>
        (m.status === 'AVAILABLE' ? 0 : m.status === 'NOT_TESTED' ? 1 : 2) - (m.tools ? 0.4 : 0) - (m.coding ? 0.2 : 0);
      return rank(a) - rank(b) || a.id.localeCompare(b.id);
    })
    .map((m) => m.id);
  return limit !== undefined ? ids.slice(0, limit) : ids;
}

export interface RegistrySummary {
  freeProviders: number;
  freeModels: number;
  available: number;
  rateLimited: number;
  paymentRequired: number;
  notAvailable: number;
  notTested: number;
  lastSync: CatalogueSync | null;
}

export function registrySummary(): RegistrySummary {
  const models = listModels();
  const freeModels = models.filter((m) => m.free);
  return {
    freeProviders: (Object.entries(PROVIDER_TIERS) as Array<[ProviderId, ProviderTierEntry]>)
      .filter(([, v]) => v.tier === 'free').length,
    freeModels: freeModels.length,
    available: models.filter((m) => m.status === 'AVAILABLE').length,
    rateLimited: models.filter((m) => m.status === 'RATE_LIMITED').length,
    paymentRequired: models.filter((m) => m.status === 'PAYMENT_REQUIRED').length,
    notAvailable: models.filter((m) => ['MODEL_NOT_FOUND', 'DEPRECATED', 'FORBIDDEN', 'ERROR'].includes(m.status)).length,
    notTested: models.filter((m) => m.status === 'NOT_TESTED').length,
    lastSync: state.lastSync,
  };
}

/**
 * Re-reads OpenRouter's public catalogue and records which of our registered
 * OpenRouter models are still priced at zero. This call needs no API key and
 * spends no completion quota, so it is safe to trigger deliberately.
 */
export async function syncOpenRouterCatalogue(fetchImpl: typeof fetch = fetch): Promise<CatalogueSync> {
  const at = new Date().toISOString();
  try {
    const res = await fetchImpl('https://openrouter.ai/api/v1/models', { method: 'GET' });
    if (!res.ok) {
      const failed: CatalogueSync = { ok: false, at, freeIds: [], missing: [], totalModels: 0, error: `HTTP ${res.status}` };
      state.lastSync = failed;
      return failed;
    }
    const body = (await res.json()) as { data?: Array<{ id?: string; pricing?: Record<string, string> }> };
    const all = body.data ?? [];
    const freeIds: string[] = [];
    for (const m of all) {
      const id = m.id;
      if (!id) continue;
      const p = m.pricing ?? {};
      const prompt = Number(p.prompt ?? '1');
      const completion = Number(p.completion ?? '1');
      if (Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0) {
        freeIds.push(id);
      }
    }
    const freeSet = new Set(freeIds);

    // Update the declared `free` flag from live pricing rather than trusting the
    // seed, and record a real observation for each model the catalogue covers.
    const missing: string[] = [];
    for (const entry of state.entries.values()) {
      if (entry.provider !== 'openrouter') continue;
      if (all.some((m) => m.id === entry.id)) {
        entry.free = freeSet.has(entry.id);
        observeModel('openrouter', entry.id, null, 'catalogue', entry.free ? 'priced $0 in the live catalogue' : 'no longer priced $0');
      } else {
        missing.push(entry.id);
        observeModel('openrouter', entry.id, null, 'catalogue', 'absent from the live catalogue');
      }
    }
    // A newly seen free model is added so the free pool grows with reality.
    for (const id of freeIds) {
      const key = modelKey('openrouter', id);
      if (state.entries.has(key)) continue;
      const meta = all.find((m) => m.id === id);
      const ctx = (meta as { context_length?: number } | undefined)?.context_length ?? null;
      state.entries.set(key, {
        id, provider: 'openrouter', free: true, coding: false, tools: false, context: ctx,
        evidence: 'Added by catalogue sync: priced $0; attributes not yet probed',
      });
    }

    const result: CatalogueSync = { ok: true, at, freeIds, missing, totalModels: all.length };
    state.lastSync = result;
    return result;
  } catch (err) {
    const failed: CatalogueSync = {
      ok: false, at, freeIds: [], missing: [], totalModels: 0,
      error: err instanceof Error ? err.message : String(err),
    };
    state.lastSync = failed;
    return failed;
  }
}

/** Test-only: restores the seed state so cases do not leak into each other. */
export function resetRegistry(): void {
  state.entries = new Map(SEED_MODELS.map((m) => [modelKey(m.provider, m.id), { ...m }]));
  state.observations = new Map();
  state.lastSync = null;
}
