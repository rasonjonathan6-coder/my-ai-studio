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

export interface AiProvider {
  id: 'openrouter' | 'gemini' | 'groq';
  label: string;
  configured: boolean;
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  connection: 'NOT_TESTED' | 'PASS' | 'FAIL';
  model: string | null;
  endpoint: string;
  cooling: boolean;
  cooldownUntil: string | null;
  cooldownReason: string | null;
}

export interface AiProvidersResponse {
  defaultProvider: string;
  order: string[];
  cooldownMs: number;
  providers: AiProvider[];
  auto: { ready: string[]; cooling: string[]; unconfigured: string[] };
  recentAttempts: Array<{
    provider: string; model: string; outcome: 'ok' | 'fallback' | 'error';
    status?: number; kind?: string; message?: string; at: string;
  }>;
}

export interface AiProviderTestResult {
  provider: string;
  label: string;
  result: 'PASS' | 'FAIL' | 'NOT_CONFIGURED';
  model: string;
  endpoint: string;
  http?: number | null;
  kind?: string;
  durationMs?: number;
  message?: string;
  reply?: string;
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
  state: 'AVAILABLE' | 'NOT_AVAILABLE' | 'ERROR' | 'CONFIGURED' | 'NOT_CONFIGURED';
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

export interface WsEvent {
  type: string;
  projectId?: string;
  timestamp: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  phase?: string;
  data?: Record<string, unknown>;
}
