/**
 * Groq client. Uses Groq's own key and endpoint; unlike Gemini it is not
 * proxied through any other provider.
 */
import { config } from '../config/index.ts';
import { OpenAiCompatibleClient, type ProviderCapabilities,
  type ProviderSettings } from './providerClient.ts';

export class GroqService {
  private readonly client = new OpenAiCompatibleClient((): ProviderSettings => ({
    name: 'Groq',
    baseUrl: config.groqBaseUrl,
    apiKey: config.groqApiKey,
    model: config.groqModel,
    timeoutMs: config.groqTimeoutMs,
    maxRetries: 1,
    capabilities: { agent: true, chat: true, streaming: true, jsonMode: true },
    quotaPatterns: [/rate limit/i, /quota/i],
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

export const groq = new GroqService();
