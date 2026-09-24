/**
 * Additional model providers, each calling its own official API directly.
 *
 * None of these transit OpenRouter or any other provider: every one has its own
 * key, endpoint and model, and a failure in one is isolated from the others.
 *
 * The remote providers all speak the OpenAI chat-completions shape, so they
 * share `OpenAiCompatibleClient`. Cloudflare and the local runtimes differ only
 * in how the base URL is composed, which the settings getter handles.
 *
 * A missing key is not an error: the service reports `configured: false` and
 * the router skips it. Local runtimes take no key at all - their configuration
 * is the base URL, and their availability is probed without generating a token.
 */
import { config } from '../config/index.ts';
import { OpenAiCompatibleClient, type ProviderSettings, type ProviderCapabilities } from './providerClient.ts';

/** The surface every provider service exposes to the router. */
export interface ProviderService {
  isConfigured(): boolean;
  status(): { configured: boolean; model: string; baseUrl: string };
  capabilities(): ProviderCapabilities;
  listModels(): Promise<{ ok: boolean; models: string[]; error?: string }>;
  chat: OpenAiCompatibleClient['chat'];
}

/** A provider that only does plain chat is not offered as a full agent brain. */
const CHAT_ONLY: ProviderCapabilities = {
  agent: false,
  chat: true,
  streaming: false,
  jsonMode: false,
  agentNote: 'CHAT_ONLY: this provider is not verified to support the agent tool protocol.',
};

export class OpenAiCompatibleService implements ProviderService {
  private readonly client: OpenAiCompatibleClient;

  public constructor(settings: () => ProviderSettings) {
    this.client = new OpenAiCompatibleClient(settings);
  }

  public isConfigured(): boolean {
    return this.client.isConfigured();
  }

  public status(): { configured: boolean; model: string; baseUrl: string } {
    const s = this.client.status();
    return { configured: s.configured, model: s.model, baseUrl: s.baseUrl };
  }

  public capabilities(): ProviderCapabilities {
    return this.client.capabilities();
  }

  public listModels(): Promise<{ ok: boolean; models: string[]; error?: string }> {
    return this.client.listModels();
  }

  public chat: OpenAiCompatibleClient['chat'] = (options) => this.client.chat(options);
}

/** Agent-capable: these follow the text JSON tool protocol used by the loop. */
const AGENT_CAPABLE: ProviderCapabilities = { agent: true, chat: true, streaming: true, jsonMode: true };

/**
 * Cloudflare's OpenAI-compatible path embeds the account id, so the key alone
 * is not enough to be considered configured: without an account id there is no
 * endpoint to call.
 */
function cloudflareBaseUrl(): string {
  const account = config.cloudflareAccountId.trim();
  return account
    ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1`
    : '';
}

export const cerebras = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'Cerebras',
  baseUrl: config.cerebrasBaseUrl,
  apiKey: config.cerebrasApiKey,
  model: config.cerebrasModel,
  timeoutMs: config.cerebrasTimeoutMs,
  maxRetries: 1,
  quotaPatterns: [/rate limit/i, /quota/i, /too many requests/i],
  capabilities: AGENT_CAPABLE,
}));

export const mistral = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'Mistral',
  baseUrl: config.mistralBaseUrl,
  apiKey: config.mistralApiKey,
  model: config.mistralModel,
  timeoutMs: config.mistralTimeoutMs,
  maxRetries: 1,
  quotaPatterns: [/rate limit/i, /quota/i, /insufficient balance/i],
  capabilities: AGENT_CAPABLE,
}));

export const cloudflare = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'Cloudflare Workers AI',
  baseUrl: cloudflareBaseUrl(),
  apiKey: config.cloudflareApiToken,
  model: config.cloudflareModel,
  timeoutMs: config.cloudflareTimeoutMs,
  maxRetries: 1,
  quotaPatterns: [/rate limit/i, /quota/i, /daily limit/i, /too many requests/i],
  capabilities: CHAT_ONLY,
}));

export const nvidia = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'NVIDIA',
  baseUrl: config.nvidiaBaseUrl,
  apiKey: config.nvidiaApiKey,
  model: config.nvidiaModel,
  timeoutMs: config.nvidiaTimeoutMs,
  maxRetries: 1,
  quotaPatterns: [/rate limit/i, /quota/i],
  capabilities: AGENT_CAPABLE,
}));

export const huggingface = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'Hugging Face',
  baseUrl: config.hfBaseUrl,
  apiKey: config.hfToken,
  model: config.hfModel,
  timeoutMs: config.hfTimeoutMs,
  maxRetries: 0,
  quotaPatterns: [/rate limit/i, /quota/i, /credit/i],
  capabilities: CHAT_ONLY,
}));

export const chutes = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'Chutes',
  baseUrl: config.chutesBaseUrl,
  apiKey: config.chutesApiKey,
  model: config.chutesModel,
  timeoutMs: config.chutesTimeoutMs,
  maxRetries: 1,
  quotaPatterns: [/rate limit/i, /quota/i, /insufficient/i],
  capabilities: AGENT_CAPABLE,
}));

export const sambanova = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'SambaNova',
  baseUrl: config.sambanovaBaseUrl,
  apiKey: config.sambanovaApiKey,
  model: config.sambanovaModel,
  timeoutMs: config.sambanovaTimeoutMs,
  maxRetries: 1,
  quotaPatterns: [/rate limit/i, /quota/i],
  capabilities: AGENT_CAPABLE,
}));

/**
 * Local runtimes take no API key: `requiresApiKey: false` makes the base URL the
 * configuration signal. `OLLAMA_BASE_URL`/`VLLM_BASE_URL` must include the
 * OpenAI-compatible suffix (e.g. `http://localhost:11434/v1`).
 */
export const ollama = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'Ollama (local)',
  baseUrl: config.ollamaBaseUrl,
  apiKey: '',
  model: config.ollamaModel,
  timeoutMs: config.ollamaTimeoutMs,
  maxRetries: 0,
  quotaPatterns: [],
  requiresApiKey: false,
  capabilities: AGENT_CAPABLE,
}));

export const vllm = new OpenAiCompatibleService((): ProviderSettings => ({
  name: 'vLLM (local)',
  baseUrl: config.vllmBaseUrl,
  apiKey: '',
  model: config.vllmModel,
  timeoutMs: config.vllmTimeoutMs,
  maxRetries: 0,
  quotaPatterns: [],
  requiresApiKey: false,
  capabilities: AGENT_CAPABLE,
}));
