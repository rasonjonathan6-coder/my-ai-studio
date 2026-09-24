/**
 * GitHub Actions integration.
 *
 * This module reports on workflow runs that really happened on GitHub. It never
 * synthesises a run: with no token or no repository it answers NOT_CONFIGURED,
 * and when GitHub is reachable but did not answer as expected it says so. A
 * configured token whose call fails is reported as ERROR with the real HTTP
 * status, not as PASS.
 *
 * The token is read from the server environment only and is never placed in a
 * response body, a log line or an artifact listing.
 */
import { config } from '../config/index.ts';
import { logger, redact } from '../lib/logger.ts';

/** What a probe of the GitHub integration concluded. */
export type GithubState =
  | 'CONFIGURED'
  | 'NOT_CONFIGURED'
  | 'AVAILABLE'
  | 'ERROR'
  | 'NOT_TESTED';

export interface WorkflowRun {
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

export interface ArtifactSummary {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
  createdAt: string;
  /** Direct download requires the API and the token; exposed only as a flag. */
  downloadable: boolean;
  archiveDownloadUrl: string | null;
}

export interface GithubStatus {
  state: GithubState;
  /** True only when a real authenticated API call succeeded. */
  connected: boolean;
  repo: string | null;
  /** Never contains the token; only whether one is present. */
  tokenConfigured: boolean;
  detail: string | null;
  latestRun: WorkflowRun | null;
  latestArtifacts: ArtifactSummary[];
}

let lastStatus: GithubStatus = {
  state: 'NOT_TESTED',
  connected: false,
  repo: config.githubRepo || null,
  tokenConfigured: config.githubToken.length > 0,
  detail: null,
  latestRun: null,
  latestArtifacts: [],
};

/** Endpoint needing no token, so the integration can be probed cheaply. */
function apiBase(): string {
  return config.githubApiBaseUrl.replace(/\/+$/, '');
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'my-ai-studio',
    'x-github-api-version': '2022-11-28',
  };
  if (config.githubToken) h.authorization = `Bearer ${config.githubToken}`;
  return h;
}

async function ghFetch(path: string, timeoutMs = config.githubTimeoutMs): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: headers(), signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    if (!res.ok) {
      // GitHub's message is useful, but it must pass through the redactor in
      // case an operator pasted a token-bearing URL into the repo field.
      const message = (body as { message?: string } | null)?.message ?? res.statusText;
      return { ok: false, status: res.status, body, error: `${res.status} ${redact(String(message))}` };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: null,
      error: aborted ? `timeout after ${timeoutMs}ms` : redact(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

function mapRun(raw: Record<string, unknown>): WorkflowRun {
  return {
    id: Number(raw.id ?? 0),
    name: String(raw.name ?? ''),
    workflowName: raw.workflow_name ? String(raw.workflow_name) : null,
    runNumber: Number(raw.run_number ?? 0),
    status: String(raw.status ?? 'unknown'),
    conclusion: raw.conclusion ? String(raw.conclusion) : null,
    headBranch: String(raw.head_branch ?? ''),
    headSha: String(raw.head_sha ?? ''),
    event: String(raw.event ?? ''),
    createdAt: String(raw.created_at ?? ''),
    updatedAt: String(raw.updated_at ?? ''),
    htmlUrl: String(raw.html_url ?? ''),
  };
}

function mapArtifact(raw: Record<string, unknown>): ArtifactSummary {
  return {
    id: Number(raw.id ?? 0),
    name: String(raw.name ?? ''),
    sizeInBytes: Number(raw.size_in_bytes ?? 0),
    expired: Boolean(raw.expired),
    createdAt: String(raw.created_at ?? ''),
    downloadable: !raw.expired,
    // Present so the UI can offer a download through the backend proxy, which
    // attaches the token server-side. The URL itself carries no credential.
    archiveDownloadUrl: raw.archive_download_url ? String(raw.archive_download_url) : null,
  };
}

/**
 * Probes the integration for real: one call to the repository. The result state
 * reflects what GitHub actually answered. With a token the call is
 * authenticated; without one a public repository is still probed, which is what
 * makes AVAILABLE a real observation rather than a claim about configuration.
 */
export async function getGithubStatus(): Promise<GithubStatus> {
  const tokenConfigured = config.githubToken.length > 0;
  const repo = config.githubRepo;

  // A repository is the one hard requirement. Without a token the public
  // endpoints still answer for a public repository, so the integration is
  // probed that way rather than being declared unusable; the token only widens
  // rate limits and unlocks private repositories.
  if (!repo) {
    lastStatus = {
      state: 'NOT_CONFIGURED',
      connected: false,
      repo: null,
      tokenConfigured,
      detail: 'GITHUB_REPO is unset on the server',
      latestRun: null,
      latestArtifacts: [],
    };
    return lastStatus;
  }

  const probe = await ghFetch(`/repos/${repo}`);
  if (!probe.ok) {
    lastStatus = {
      state: 'ERROR',
      connected: false,
      repo,
      tokenConfigured,
      detail: `repository probe failed: ${probe.error ?? 'unknown error'}`,
      latestRun: null,
      latestArtifacts: [],
    };
    logger.warn('github repository probe failed', { repo, error: probe.error ?? null });
    return lastStatus;
  }

  const repoInfo = probe.body as Record<string, unknown>;
  const runs = await ghFetch(`/repos/${repo}/actions/runs?per_page=10`);
  let latestRun: WorkflowRun | null = null;
  let latestArtifacts: ArtifactSummary[] = [];

  if (runs.ok) {
    const list = (runs.body as { workflow_runs?: Array<Record<string, unknown>> }).workflow_runs ?? [];
    if (list.length > 0) {
      latestRun = mapRun(list[0]);
      const artifacts = await ghFetch(`/repos/${repo}/actions/runs/${latestRun.id}/artifacts`);
      if (artifacts.ok) {
        const items = (artifacts.body as { artifacts?: Array<Record<string, unknown>> }).artifacts ?? [];
        latestArtifacts = items.map(mapArtifact);
      }
    }
  } else {
    logger.warn('github workflow run listing failed', { repo, error: runs.error ?? null });
  }

  lastStatus = {
    state: 'AVAILABLE',
    connected: true,
    repo,
    tokenConfigured,
    detail: runs.ok
      ? `repository reachable; ${String(repoInfo.full_name ?? repo)} default branch ${String(repoInfo.default_branch ?? 'unknown')}`
      : `repository reachable but workflow runs could not be listed: ${runs.error ?? 'unknown error'}`,
    latestRun,
    latestArtifacts,
  };
  return lastStatus;
}

/** The most recent probe result, without issuing a call. */
export function cachedGithubStatus(): GithubStatus {
  return lastStatus;
}

/**
 * Streams an artifact archive through the backend so the token stays
 * server-side. Returns null when the integration is not usable, so the caller
 * can answer 404/503 rather than a fabricated download.
 */
export async function downloadArtifact(repo: string, artifactId: number): Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; contentType: string; error?: string }> {
  if (config.githubToken.length === 0) {
    return { ok: false, status: 503, body: null, contentType: '', error: 'GITHUB_TOKEN is not configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.githubTimeoutMs);
  try {
    // The artifacts endpoint redirects to a signed URL; fetch follows it and
    // the Authorization header is dropped by the redirect target, which is the
    // intended behaviour.
    const res = await fetch(`${apiBase()}/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
      headers: headers(),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      return { ok: false, status: res.status, body: null, contentType: '', error: `HTTP ${res.status}` };
    }
    return {
      ok: true,
      status: 200,
      body: res.body,
      contentType: res.headers.get('content-type') ?? 'application/zip',
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: null,
      contentType: '',
      error: aborted ? `timeout after ${config.githubTimeoutMs}ms` : redact(err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}
