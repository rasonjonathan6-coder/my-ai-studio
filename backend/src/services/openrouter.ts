/**
 * OpenRouter integration. Server-side only: the API key is read from the
 * backend environment and never included in any response body, log line or
 * artifact. Callers receive either a real completion or a structured error.
 *
 * The transport lives in `providerClient.ts`; this module only supplies
 * OpenRouter's endpoint, key and limit semantics. The exported types are kept
 * here because the rest of the backend imports them from this module.
 */
import { config } from '../config/index.ts';
import {
  OpenAiCompatibleClient,
  type ChatFailure,
  type ChatMessage,
  type ChatOptions,
  type ChatOutcome,
  type ChatResult,
  type ProviderCapabilities,
  type ProviderSettings,
} from './providerClient.ts';

export type { ChatFailure, ChatMessage, ChatOptions, ChatOutcome, ChatResult };

export class OpenRouterService {
  private readonly client = new OpenAiCompatibleClient((): ProviderSettings => ({
    name: 'OpenRouter',
    baseUrl: config.openRouterBaseUrl,
    apiKey: config.openRouterApiKey,
    model: config.openRouterModel,
    timeoutMs: config.openRouterTimeoutMs,
    maxRetries: config.openRouterMaxRetries,
    headers: {
      'HTTP-Referer': config.openRouterReferer,
      'X-Title': config.openRouterTitle,
    },
    capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
    quotaPatterns: [/free-models-per-day/i, /openrouter_free_tier_daily/i],
  }));

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

  public chat(options: ChatOptions): Promise<ChatOutcome> {
    return this.client.chat(options);
  }
}

export const openRouter = new OpenRouterService();
