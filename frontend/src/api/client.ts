import type {
  AgentRun, AiAutoProbeResponse, AiProviderProbeResult, AiProviderTestResult, AiProvidersResponse,
  BuildResult, CommandResult, Conversation,
  ExportResult, FileEntry, Message, PreviewResult, Project, ProviderSelection, SecurityScan, SystemStatus, User,
} from './types.ts';

/** Re-exported so callers have a single import site for the contract types. */
export type { ProviderSelection } from './types.ts';

/**
 * The API base URL. Only VITE_API_URL is read, and it must never contain a
 * secret: Vite inlines every VITE_* value into the shipped bundle.
 */
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    // Without this, `name` stays 'Error' and callers cannot tell an API failure
    // apart from an unrelated Error.
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as { error?: string; code?: string };
    throw new ApiError(res.status, body.code ?? 'http_error', body.error ?? `HTTP ${res.status}`);
  }
  return parsed as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  baseUrl: API_URL,

  // auth
  register: (email: string, password: string, displayName?: string) =>
    request<{ user: User; token: string }>('/api/auth/register', json({ email, password, displayName })),
  login: (email: string, password: string) =>
    request<{ user: User; token: string }>('/api/auth/login', json({ email, password })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: User }>('/api/auth/me'),

  // system
  health: () => request<{ ok: boolean; service: string; version: string }>('/api/health'),
  systemStatus: () => request<SystemStatus>('/api/system/status'),
  systemInfo: () => request<SystemStatus & { config: Record<string, unknown> }>('/api/system/info'),
  emulator: () => request<PreviewResult & { status: string; note: string }>('/api/system/emulator'),

  // projects
  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  createProject: (input: { name: string; template?: string; description?: string }) =>
    request<{ project: Project }>('/api/projects', json(input)),
  getProject: (id: string) => request<{ project: Project; workspace: { fileCount: number; totalSize: number } }>(`/api/projects/${id}`),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  templates: () => request<{ templates: Array<{ id: string; name: string; kind: string; description: string }> }>('/api/projects/templates'),

  // files
  listFiles: (id: string, dir = '.', depth = 4) =>
    request<{ files: FileEntry[]; root: string }>(`/api/projects/${id}/files?dir=${encodeURIComponent(dir)}&depth=${depth}`),
  readFile: (id: string, path: string) =>
    request<{ path: string; content: string; size: number }>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`),
  writeFile: (id: string, path: string, content: string) =>
    request<{ path: string; size: number; created: boolean }>(`/api/projects/${id}/file`, { method: 'PUT', body: JSON.stringify({ path, content }) }),
  createFile: (id: string, path: string, content: string) =>
    request<{ path: string; size: number; created: boolean }>(`/api/projects/${id}/file`, json({ path, content })),
  deleteFile: (id: string, path: string) =>
    request<{ deleted: boolean }>(`/api/projects/${id}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  searchFiles: (id: string, q: string) =>
    request<{ matches: Array<{ path: string; line: number; text: string }>; count: number }>(`/api/projects/${id}/search?q=${encodeURIComponent(q)}`),

  // conversation
  conversation: (id: string) => request<{ conversation: Conversation; messages: Message[] }>(`/api/projects/${id}/conversation`),

  // terminal
  terminal: (id: string, command: string) => request<CommandResult>(`/api/projects/${id}/terminal`, json({ command })),
  terminalHistory: (id: string) => request<{ commands: CommandResult[] }>(`/api/projects/${id}/terminal`),

  // agent
  runAgent: (id: string, prompt: string, provider: ProviderSelection = 'auto') =>
    request<{ agentRunId: string; status: string }>(`/api/projects/${id}/agent/run`, json({ prompt, provider })),
  agentRuns: (id: string) => request<{ runs: AgentRun[] }>(`/api/projects/${id}/agent/runs`),
  cancelAgent: (id: string, runId: string) =>
    request<{ cancelled: boolean }>(`/api/projects/${id}/agent/runs/${runId}/cancel`, { method: 'POST' }),

  // ai providers
  aiProviders: () => request<AiProvidersResponse>('/api/ai/providers'),
  testAiProvider: (provider: string) =>
    request<AiProviderTestResult>(`/api/ai/providers/${provider}/test`, { method: 'POST', ...json({}) }),
  resetAiProvider: (provider: string) =>
    request<{ provider: string; cooldownCleared: boolean }>(`/api/ai/providers/${provider}/reset`, { method: 'POST' }),
  // Reachability check that spends no completion quota (lists models).
  probeAiProvider: (provider: string) =>
    request<AiProviderProbeResult>(`/api/ai/providers/${provider}/probe`, { method: 'POST', ...json({}) }),
  // One real request through the AUTO path, to observe the failover chain.
  autoProbeAi: () =>
    request<AiAutoProbeResponse>('/api/ai/providers/auto/auto-probe', { method: 'POST', ...json({}) }),

  // tests / builds
  runTests: (id: string) => request<{ test: { status: string; framework: string | null; command: string | null; passed: number; failed: number; skipped: number; durationMs: number; log: string; error: string | null } }>(`/api/projects/${id}/test`, { method: 'POST' }),
  build: (id: string, target: 'debug' | 'release' = 'debug') =>
    request<{ build: BuildResult }>(`/api/projects/${id}/build`, json({ target })),
  getBuild: (id: string, buildId: string) =>
    request<{ build: BuildResult }>(`/api/projects/${id}/build/${buildId}`),
  builds: (id: string) => request<{ builds: Array<{ id: string; status: string; target: string; created_at: string; duration_ms: number | null }> }>(`/api/projects/${id}/builds`),

  // security / preview / export
  securityScan: (id: string) => request<{ scan: SecurityScan }>(`/api/projects/${id}/security/scan`, { method: 'POST' }),
  preview: (id: string) => request<{ preview: PreviewResult }>(`/api/projects/${id}/preview`, { method: 'POST' }),
  exportProject: (id: string) => request<{ export: ExportResult }>(`/api/projects/${id}/export`, { method: 'POST' }),
  artifacts: (id: string) => request<{ artifacts: Array<{ id: string; kind: string; rel_path: string; size_bytes: number; sha256: string; created_at: string }> }>(`/api/projects/${id}/artifacts`),
};

export function downloadUrl(projectId: string, kind: 'apk' | 'zip' | 'logs'): string {
  return `${API_URL}/api/projects/${projectId}/download/${kind}`;
}

export function websocketUrl(projectId: string): string {
  const base = API_URL || window.location.origin;
  const url = new URL(base.startsWith('http') ? base : window.location.origin + base);
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}/ws?projectId=${encodeURIComponent(projectId)}`;
}
