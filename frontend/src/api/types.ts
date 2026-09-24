/** Shared API contract types. Mirrors the backend JSON shapes. */

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  template: string;
  kind: 'generic' | 'android' | 'node' | 'static';
  package_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  modified: string;
}

export interface CommandResult {
  id: string;
  command: string;
  backend: 'docker' | 'host';
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  status: 'succeeded' | 'failed' | 'timeout' | 'rejected';
}

/** A row from the terminal history; `source` is 'agent' for agent-driven runs. */
export interface CommandHistoryEntry {
  id: string;
  command: string;
  source: 'terminal' | 'agent' | 'build' | 'test' | null;
  exit_code: number | null;
  status: string;
  created_at: string;
  duration_ms: number | null;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  project_id: string;
  title: string | null;
  created_at: string;
}

export interface AgentRun {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  phase: string;
  model: string;
  provider: string | null;
  failover_from: string | null;
  failover_reason: string | null;
  fix_attempts: number;
  max_fix_attempts: number;
  summary: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type ProviderId =
  | 'openrouter' | 'gemini' | 'groq' | 'cerebras' | 'mistral' | 'cloudflare'
  | 'nvidia' | 'huggingface' | 'chutes' | 'sambanova' | 'ollama' | 'vllm';

export type ProviderSelection = 'auto' | ProviderId;

export interface ProviderCapabilities {
  agent: boolean;
  chat: boolean;
  streaming: boolean;
  jsonMode: boolean;
  agentNote?: string;
}

export interface AiProvider {
  id: ProviderId;
  label: string;
  local: boolean;
  configured: boolean;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  connection: 'NOT_TESTED' | 'PASS' | 'FAIL';
  model: string | null;
  endpoint: string;
  cooling: boolean;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  capabilities: ProviderCapabilities;
  /** Whether this provider is usable without billing, and the reason. */
  tier: 'free' | 'paid';
  tierReason: string;
  /** Free models FREE_ONLY may use on this provider right now. */
  freeModels: string[];
}

/** Status vocabulary, derived from the HTTP code a real request returned. */
export type ModelStatus =
  | 'NOT_TESTED' | 'AVAILABLE' | 'RATE_LIMITED' | 'PAYMENT_REQUIRED'
  | 'FORBIDDEN' | 'MODEL_NOT_FOUND' | 'DEPRECATED' | 'ERROR';

export interface AiModel {
  id: string;
  provider: ProviderId;
  free: boolean;
  coding: boolean;
  tools: boolean;
  context: number | null;
  /** The source for the declared attributes above. */
  evidence: string;
  status: ModelStatus;
  lastHttpStatus: number | null;
  lastTested: string | null;
  lastMessage: string | null;
  observedVia: 'completion' | 'catalogue' | null;
}

export interface ModelSummary {
  freeProviders: number;
  freeModels: number;
  available: number;
  rateLimited: number;
  paymentRequired: number;
  notAvailable: number;
  notTested: number;
  lastSync: { ok: boolean; at: string; freeIds: string[]; missing: string[]; totalModels: number; error?: string } | null;
}

export interface FreePlanEntry {
  provider: ProviderId;
  label: string;
  tier: 'free' | 'paid';
  candidates: string[];
  skippedReason: string | null;
}

export interface AiModelTestResult {
  provider: string;
  model: string;
  result: 'PASS' | 'FAIL' | 'NOT_CONFIGURED';
  status: ModelStatus | 'NOT_CONFIGURED';
  http: number | null;
  classification?: string | null;
  durationMs?: number;
  quotaCost?: string;
  reply?: string;
  message?: string | null;
}

/** Live per-provider state. Unknown values are null, never guessed. */
export interface ProviderState {
  id: ProviderId;
  label: string;
  local: boolean;
  configured: boolean;
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
  rateLimitRemainingRequests: number | null;
  rateLimitRemainingTokens: number | null;
  rateLimitResetAt: string | null;
  capabilities: ProviderCapabilities;
}

export interface AiAttempt {
  provider: ProviderId;
  model: string;
  endpoint: string;
  outcome: 'ok' | 'fallback' | 'error';
  status?: number;
  kind?: string;
  classification?: string;
  message?: string;
  at: string;
}

export interface AiProviderCurrent {
  provider: ProviderId | null;
  label: string | null;
  model: string | null;
  reason: string;
}

export interface AiProvidersResponse {
  defaultProvider: string;
  order: string[];
  priority: string[];
  cooldownMs: number;
  providers: AiProvider[];
  providerStates: ProviderState[];
  current: AiProviderCurrent;
  auto: { ready: string[]; cooling: string[]; unconfigured: string[] };
  recentAttempts: AiAttempt[];
  requestCounters: Record<string, { date: string; attempts: number; ok: number; failed: number }>;
  /** Always 'unknown': no provider API exposes a remaining-quota figure. */
  quotaRemaining: 'unknown';
  /** True when paid providers and models are excluded from every route. */
  freeOnly: boolean;
  models: AiModel[];
  modelSummary: ModelSummary;
  freePlan: FreePlanEntry[];
}

export interface AiProviderTestResult {
  provider: string;
  label: string;
  result: 'PASS' | 'FAIL' | 'NOT_CONFIGURED';
  model: string;
  endpoint: string;
  http?: number | null;
  kind?: string;
  classification?: string | null;
  quotaExhausted?: boolean;
  durationMs?: number;
  quotaCost?: string;
  message?: string;
  reply?: string;
}

export interface AiProviderProbeResult {
  provider: string;
  label: string;
  result: 'REACHABLE' | 'FAIL' | 'NOT_CONFIGURED';
  endpoint: string;
  quotaCost: string;
  models?: string[];
  modelCount?: number;
  durationMs?: number;
  message?: string | null;
}

export interface AiAutoProbeResponse {
  ok: boolean;
  answeredBy: string | null;
  failoverFrom: string | null;
  attempts: AiAttempt[];
  quotaCost: string;
  message: string | null;
}

export interface ApkInspection {
  path: string;
  exists: boolean;
  sizeBytes: number;
  sha256: string | null;
  packageName: string | null;
  versionName: string | null;
  versionCode: string | null;
  minSdk: string | null;
  targetSdk: string | null;
  permissions: string[];
  activities: string[];
  services: string[];
  receivers: string[];
  providers: string[];
  abis: string[];
  nativeLibs: string[];
  dexFiles: number;
  signed: boolean;
  signatureSchemes: string[];
  debugBuild: boolean;
  toolsUsed: string[];
  notes: string[];
}

export interface SecurityScan {
  status: 'clean' | 'failed' | 'error';
  filesScanned: number;
  findings: Array<{ file: string; line: number | null; rule: string; preview: string; severity: string }>;
  apkScanned: boolean;
  apkNote: string | null;
  error: string | null;
}

export interface BuildResult {
  id: string;
  kind: string;
  target: string;
  status: 'succeeded' | 'failed' | 'error';
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  apk: { path: string; relPath: string; sizeBytes: number; sha256: string } | null;
  inspection: ApkInspection | null;
  security: SecurityScan | null;
  error: string | null;
  logTail: string;
}

export interface SystemProbe {
  name: string;
  state: 'AVAILABLE' | 'NOT_AVAILABLE' | 'NOT_TESTED' | 'ERROR' | 'CONFIGURED' | 'NOT_CONFIGURED';
  detail: string | null;
  version: string | null;
}

export interface SystemStatus {
  generatedAt: string;
  host: { platform: string; release: string; cpuCount: number; totalMemBytes: number; freeMemBytes: number; uptimeSec: number };
  disk: { available: boolean; totalBytes: number; freeBytes: number } | null;
  executionBackend: 'docker' | 'host';
  sandboxEnabled: boolean;
  probes: SystemProbe[];
  ai?: {
    defaultProvider: string;
    order: string[];
    cooldowns: Record<string, { cooling: boolean; until: string | null; reason: string | null }>;
  };
  jobs: { active: number; pending: number; max: number };
}

export interface PreviewResult {
  available: boolean;
  status: string;
  devices: string[];
  installed: boolean;
  launched: boolean;
  packageName: string | null;
  logcat: string[];
  screenshots: string[];
  message: string;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}

export interface ExportResult {
  ok: boolean;
  zipPath: string | null;
  relPath: string | null;
  sizeBytes: number;
  sha256: string | null;
  entryCount: number;
  excludedEntries: string[];
  error: string | null;
}

export interface GithubRun {
  id: number;
  name: string;
  workflowName: string | null;
  runNumber: number;
  status: string;
  conclusion: string | null;
  headBranch: string;
  headSha: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface GithubArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
  createdAt: string;
  downloadable: boolean;
  archiveDownloadUrl: string | null;
}

export interface GithubStatus {
  state: 'CONFIGURED' | 'NOT_CONFIGURED' | 'AVAILABLE' | 'ERROR' | 'NOT_TESTED';
  connected: boolean;
  repo: string | null;
  tokenConfigured: boolean;
  detail: string | null;
  latestRun: GithubRun | null;
  latestArtifacts: GithubArtifact[];
}

export interface WsEvent {
  type: string;
  projectId?: string;
  timestamp: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  phase?: string;
  data?: Record<string, unknown>;
}
