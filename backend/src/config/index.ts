import path from 'node:path';
import { randomBytes } from 'node:crypto';

function env(key: string, fallback = ''): string {
  // An empty value in a .env file (KEY=) means "not set", matching how int()
  // and bool() already treat it. Otherwise KEY= would defeat the fallback.
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const isProduction = env('NODE_ENV', 'development') === 'production';

// A random ephemeral secret keeps dev usable without pretending a real secret
// is configured. In production a missing JWT_SECRET is a hard failure.
const configuredJwtSecret = env('JWT_SECRET');
if (isProduction && configuredJwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to at least 32 characters in production');
}
const jwtSecret = configuredJwtSecret || randomBytes(48).toString('hex');

const sameSiteRaw = env('SESSION_COOKIE_SAMESITE', 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(sameSiteRaw)) {
  throw new Error(`SESSION_COOKIE_SAMESITE must be lax, strict or none (got "${sameSiteRaw}")`);
}
const sessionCookieSameSite = sameSiteRaw as 'lax' | 'strict' | 'none';
// Browsers reject SameSite=None without Secure, so enabling None forces Secure
// even outside production rather than silently dropping the cookie.
const sessionCookieSecure = sessionCookieSameSite === 'none' || isProduction;

export const config = {
  env: env('NODE_ENV', 'development'),
  isProduction,
  port: int('PORT', 8080),
  host: env('HOST', '0.0.0.0'),

  databaseUrl: env('DATABASE_URL'),
  databaseSsl: bool('DATABASE_SSL', false),
  databasePoolMax: int('DATABASE_POOL_MAX', 10),
  databaseConnectTimeoutMs: int('DATABASE_CONNECT_TIMEOUT_MS', 5000),

  jwtSecret,
  jwtSecretWasGenerated: !configuredJwtSecret,
  jwtTtlSeconds: int('JWT_TTL_SECONDS', 60 * 60 * 24 * 7),
  sessionCookieName: env('SESSION_COOKIE_NAME', 'mas_session'),
  // 'lax' is fine when the frontend shares the API's site. A cross-site
  // deployment (frontend on Cloudflare Pages, API elsewhere) needs 'none',
  // which browsers only accept together with Secure.
  sessionCookieSameSite,
  sessionCookieSecure,

  openRouterApiKey: env('OPENROUTER_API_KEY'),
  // A precise free coding model performs better than the generic
  // 'openrouter/free' alias, which routes to an unspecified backend.
  openRouterModel: env('OPENROUTER_MODEL', 'qwen/qwen3.8-27b:free'),
  openRouterBaseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  openRouterTimeoutMs: int('OPENROUTER_TIMEOUT_MS', 120000),
  openRouterMaxRetries: int('OPENROUTER_MAX_RETRIES', 3),
  openRouterReferer: env('OPENROUTER_REFERER', 'https://my-ai-studio.local'),
  openRouterTitle: env('OPENROUTER_TITLE', 'My AI Studio'),

  // Google Gemini is reached through its OpenAI-compatible surface, so it
  // shares the chat-completions shape with the other providers. The key and the
  // endpoint are its own: Gemini traffic must never transit OpenRouter.
  geminiApiKey: env('GEMINI_API_KEY'),
  geminiModel: env('GEMINI_MODEL', 'gemini-3.6-flash'),
  geminiBaseUrl: env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
  geminiTimeoutMs: int('GEMINI_TIMEOUT_MS', 120000),

  groqApiKey: env('GROQ_API_KEY'),
  // The agent drives its tools through a text JSON protocol, not native tool
  // calling. Groq's gpt-oss models ship a built-in repo_browser tool that
  // intercepts tool-ish prompts and rejects the turn with HTTP 400
  // tool_use_failed, so qwen (which follows the protocol) is the default.
  groqModel: env('GROQ_MODEL', 'qwen/qwen3.8-27b'),
  groqBaseUrl: env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
  groqTimeoutMs: int('GROQ_TIMEOUT_MS', 120000),

  // --- Additional providers, each calling its own official API directly. ---
  // Every one is optional: an absent key means NOT_CONFIGURED, not an error.
  cerebrasApiKey: env('CEREBRAS_API_KEY'),
  cerebrasModel: env('CEREBRAS_MODEL', 'qwen-3-235b-a22b-instruct-2507'),
  cerebrasBaseUrl: env('CEREBRAS_BASE_URL', 'https://api.cerebras.ai/v1'),
  cerebrasTimeoutMs: int('CEREBRAS_TIMEOUT_MS', 120000),

  mistralApiKey: env('MISTRAL_API_KEY'),
  mistralModel: env('MISTRAL_MODEL', 'mistral-small-latest'),
  mistralBaseUrl: env('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1'),
  mistralTimeoutMs: int('MISTRAL_TIMEOUT_MS', 120000),

  // Cloudflare has no OpenAI-compatible root: the account id is part of the
  // path, so the adapter builds the URL rather than reading a fixed base.
  cloudflareApiToken: env('CLOUDFLARE_API_TOKEN'),
  cloudflareAccountId: env('CLOUDFLARE_ACCOUNT_ID'),
  cloudflareModel: env('CLOUDFLARE_MODEL', '@cf/meta/llama-3.1-8b-instruct'),
  cloudflareTimeoutMs: int('CLOUDFLARE_TIMEOUT_MS', 120000),

  nvidiaApiKey: env('NVIDIA_API_KEY'),
  nvidiaModel: env('NVIDIA_MODEL', 'nvidia/llama-3.3-nemotron-super-49b-v1'),
  nvidiaBaseUrl: env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
  nvidiaTimeoutMs: int('NVIDIA_TIMEOUT_MS', 120000),

  // Hugging Face routes to whichever backend the model lists. Free credit is
  // small, so its priority is last among remote providers by default.
  hfToken: env('HF_TOKEN'),
  hfModel: env('HF_MODEL', 'Qwen/Qwen2.5-7B-Instruct'),
  hfBaseUrl: env('HF_BASE_URL', 'https://router.huggingface.co/v1'),
  hfTimeoutMs: int('HF_TIMEOUT_MS', 120000),

  chutesApiKey: env('CHUTES_API_KEY'),
  chutesModel: env('CHUTES_MODEL', 'deepseek-ai/DeepSeek-V3-0324'),
  chutesBaseUrl: env('CHUTES_BASE_URL', 'https://llm.chutes.ai/v1'),
  chutesTimeoutMs: int('CHUTES_TIMEOUT_MS', 120000),

  sambanovaApiKey: env('SAMBANOVA_API_KEY'),
  sambanovaModel: env('SAMBANOVA_MODEL', 'Meta-Llama-3.3-70B-Instruct'),
  sambanovaBaseUrl: env('SAMBANOVA_BASE_URL', 'https://api.sambanova.ai/v1'),
  sambanovaTimeoutMs: int('SAMBANOVA_TIMEOUT_MS', 120000),

  // Local runtimes. No API key: availability is "is something listening here",
  // which is probed by the health check without generating any token.
  ollamaBaseUrl: env('OLLAMA_BASE_URL', ''),
  ollamaModel: env('OLLAMA_MODEL', 'qwen2.5-coder:7b'),
  ollamaTimeoutMs: int('OLLAMA_TIMEOUT_MS', 120000),
  vllmBaseUrl: env('VLLM_BASE_URL', ''),
  vllmModel: env('VLLM_MODEL', ''),
  vllmTimeoutMs: int('VLLM_TIMEOUT_MS', 120000),

  // Which provider the agent uses by default. 'auto' walks providerOrder and
  // fails over on temporary limits only; a named provider pins the run to it.
  aiDefaultProvider: env('AI_DEFAULT_PROVIDER', 'auto'),
  // AI_PROVIDER_PRIORITY is the documented forward-looking name; the older
  // AI_PROVIDER_ORDER is still honoured so existing deployments keep working.
  aiProviderPriority: env('AI_PROVIDER_PRIORITY', env('AI_PROVIDER_ORDER', 'openrouter,gemini,groq'))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  // How long a provider stays out of the rotation after a quota/rate-limit
  // response, so a run does not hammer a provider that is known to be down.
  // This is the first backoff step; repeated limits escalate up to the cap.
  aiProviderCooldownMs: int('AI_PROVIDER_COOLDOWN_MS', 30 * 1000),
  aiProviderCooldownMaxMs: int('AI_PROVIDER_COOLDOWN_MAX_MS', 15 * 60 * 1000),

  workspaceRoot: path.resolve(env('WORKSPACE_PATH', path.join(process.cwd(), 'workspace-data', 'projects'))),
  storageRoot: path.resolve(env('STORAGE_PATH', path.join(process.cwd(), 'workspace-data', 'storage'))),

  maxFixAttempts: int('MAX_FIX_ATTEMPTS', 5),
  commandTimeoutMs: int('COMMAND_TIMEOUT_MS', 10 * 60 * 1000),
  buildTimeoutMs: int('BUILD_TIMEOUT_MS', 30 * 60 * 1000),
  agentTimeoutMs: int('AGENT_TIMEOUT_MS', 20 * 60 * 1000),
  maxOutputBytes: int('MAX_OUTPUT_BYTES', 512 * 1024),
  maxFileBytes: int('MAX_FILE_BYTES', 2 * 1024 * 1024),
  maxProjectBytes: int('MAX_PROJECT_BYTES', 512 * 1024 * 1024),
  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 3),
  maxRequestBody: env('MAX_REQUEST_BODY', '4mb'),
  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: int('RATE_LIMIT_MAX', 240),
  terminalRateLimitMax: int('TERMINAL_RATE_LIMIT_MAX', 30),
  agentRateLimitMax: int('AGENT_RATE_LIMIT_MAX', 15),
  buildRateLimitMax: int('BUILD_RATE_LIMIT_MAX', 10),

  sandbox: {
    enabled: bool('SANDBOX_ENABLED', false),
    image: env('SANDBOX_IMAGE', 'my-ai-studio-sandbox:latest'),
    memoryLimit: env('SANDBOX_MEMORY', '2g'),
    cpuLimit: env('SANDBOX_CPUS', '2'),
    pidsLimit: int('SANDBOX_PIDS_LIMIT', 512),
    networkDisabled: bool('SANDBOX_NETWORK_DISABLED', false),
    // Extra bind mounts for toolchains that live outside the image, e.g.
    // "/opt/android-sdk:/opt/android-sdk:ro". Format:
    // "host:container[:ro]" entries separated by commas. Kept empty by default
    // so a plain deployment exposes nothing extra to the sandbox.
    extraMounts: env('SANDBOX_EXTRA_MOUNTS', '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },

  androidHome: env('ANDROID_HOME', env('ANDROID_SDK_ROOT', '')),
  javaHome: env('JAVA_HOME', ''),
  gradleUserHome: env('GRADLE_USER_HOME', path.join(process.env.HOME ?? '/tmp', '.gradle')),

  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  logLevel: env('LOG_LEVEL', 'info'),
} as const;

export type AppConfig = typeof config;
