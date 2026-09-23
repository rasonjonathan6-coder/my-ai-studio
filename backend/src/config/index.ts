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
  openRouterModel: env('OPENROUTER_MODEL', 'openrouter/free'),
  openRouterBaseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  openRouterTimeoutMs: int('OPENROUTER_TIMEOUT_MS', 120000),
  openRouterMaxRetries: int('OPENROUTER_MAX_RETRIES', 3),
  openRouterReferer: env('OPENROUTER_REFERER', 'https://my-ai-studio.local'),
  openRouterTitle: env('OPENROUTER_TITLE', 'My AI Studio'),

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
