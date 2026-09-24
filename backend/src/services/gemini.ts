/**
 * Google Gemini client. Reachable through Google's OpenAI-compatible surface,
 * so it shares the chat-completions transport, but the key and endpoint are its
 * own: Gemini requests are sent directly to Google and never silently proxied
 * through OpenRouter.
 */
import { config } from '../config/index.ts';
import { OpenAiCompatibleClient, type ProviderCapabilities,
  type ProviderSettings } from './providerClient.ts';

export class GeminiService {
  private readonly client = new OpenAiCompatibleClient((): ProviderSettings => ({
    name: 'Google Gemini',
    baseUrl: config.geminiBaseUrl,
    apiKey: config.geminiApiKey,
    model: config.geminiModel,
    timeoutMs: config.geminiTimeoutMs,
    // Gemini signals quota with RESOURCE_EXHAUSTED and demand spikes with 503.
    maxRetries: 1,
    capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
    quotaPatterns: [/RESOURCE_EXHAUSTED/i, /quota/i],
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

  public chat: OpenAiCompatibleClient['chat'] = (options) => this.client.chat(options);
}

export const gemini = new GeminiService();
