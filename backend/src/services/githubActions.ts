/**
 * GitHub Actions integration.
 *
 * This module reports on workflow runs that really happened on GitHub. It never
 * synthesises a run: with no token or no repository it answers NOT_CONFIGURED,
 * and when GitHub is reachable but did not answer as expected it says so. A
 * configured token whose call fails is reported as ERROR with the real HTTP
 * status, not as PASS.
 *
 * Credentials are read from the server environment only and are never placed in
 * a response body, a log line or an artifact listing. A GitHub App installation
 * token is preferred when the App variables are present; GITHUB_TOKEN remains
 * supported so an existing deployment keeps working.
 */
import crypto from 'node:crypto';
import { config } from '../config/index.ts';
import { logger, redact } from '../lib/logger.ts';
import { readZipEntries, readZipEntry } from '../lib/apkZip.ts';

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
  /** 'app', 'token' or 'none' — which credential shape the server holds. */
  credential: CredentialKind;
  /** The workflow the build endpoint will dispatch. */
  workflow: string;
  detail: string | null;
  latestRun: WorkflowRun | null;
  latestArtifacts: ArtifactSummary[];
  /**
   * Whether the credential can actually publish. A read-only installation token
   * probes green but cannot push, so the Build Center needs this to explain a
   * refused publish instead of showing a healthy integration.
   */
  canWrite: boolean | null;
}

let lastStatus: GithubStatus = {
  state: 'NOT_TESTED',
  connected: false,
  repo: config.githubRepo || null,
  tokenConfigured: config.githubToken.length > 0,
  credential: credentialKind(),
  workflow: config.githubWorkflow,
  detail: null,
  latestRun: null,
  latestArtifacts: [],
  canWrite: null,
};

/** Endpoint needing no token, so the integration can be probed cheaply. */
function apiBase(): string {
  return config.githubApiBaseUrl.replace(/\/+$/, '');
}

/** Which credential shape the server holds. Never the credential itself. */
export type CredentialKind = 'app' | 'token' | 'none';

export function credentialKind(): CredentialKind {
  if (config.githubAppId && config.githubAppPrivateKey && config.githubAppInstallationId) return 'app';
  if (config.githubToken) return 'token';
  return 'none';
}

/**
 * Mints a short-lived installation token for the configured GitHub App.
 *
 * The JWT is signed locally with the App private key (RS256, as GitHub
 * requires) and exchanged for an installation token that expires within the
 * hour. Only the resulting token is ever used for API calls; the private key
 * stays in this function's scope and is never logged.
 */
async function appInstallationToken(): Promise<{ ok: boolean; token: string; error?: string }> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.githubAppId }));
  const signingInput = `${header}.${payload}`;
  try {
    const key = config.githubAppPrivateKey.replace(/\\n/g, '\n');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), key);
    const jwt = `${signingInput}.${signature.toString('base64url')}`;
    const res = await fetch(`${apiBase()}/app/installations/${config.githubAppInstallationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'my-ai-studio',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || !body.token) {
      return { ok: false, token: '', error: `${res.status} ${redact(body.message ?? res.statusText)}` };
    }
    return { ok: true, token: body.token };
  } catch (err) {
    // A malformed private key lands here; the message is redacted because a
    // PEM can leak a fragment of the key into an error string.
    return { ok: false, token: '', error: redact(err instanceof Error ? err.message : String(err)) };
  }
}

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

/** Resolves the credential for one API call. Discarded immediately after use. */
async function resolveCredential(): Promise<{ ok: boolean; token: string | null; kind: CredentialKind; error?: string }> {
  const kind = credentialKind();
  if (kind === 'none') return { ok: false, token: null, kind, error: 'no GitHub credential is configured' };
  if (kind === 'token') return { ok: true, token: config.githubToken, kind };
  const minted = await appInstallationToken();
  if (!minted.ok) return { ok: false, token: null, kind, error: `GitHub App token request failed: ${minted.error}` };
  return { ok: true, token: minted.token, kind };
}

function headers(token?: string | null): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'my-ai-studio',
    'x-github-api-version': '2022-11-28',
  };
  const bearer = token ?? config.githubToken;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  return h;
}

async function ghFetch(path: string, timeoutMs = config.githubTimeoutMs, init?: { method?: string; body?: unknown; token?: string | null }): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        ...headers(init?.token),
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
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
  const credential = credentialKind();
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
      credential,
      workflow: config.githubWorkflow,
      detail: 'GITHUB_REPO is unset on the server',
      latestRun: null,
      latestArtifacts: [],
      canWrite: null,
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
      credential,
      workflow: config.githubWorkflow,
      detail: `repository probe failed: ${probe.error ?? 'unknown error'}`,
      latestRun: null,
      latestArtifacts: [],
      canWrite: null,
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

  const canWrite = await probeWriteCapability(repo);
  lastStatus = {
    state: 'AVAILABLE',
    connected: true,
    repo,
    tokenConfigured,
    credential,
    workflow: config.githubWorkflow,
    detail: runs.ok
      ? `repository reachable; ${String(repoInfo.full_name ?? repo)} default branch ${String(repoInfo.default_branch ?? 'unknown')}`
      : `repository reachable but workflow runs could not be listed: ${runs.error ?? 'unknown error'}`,
    latestRun,
    latestArtifacts,
    canWrite,
  };
  if (canWrite === false) {
    lastStatus.detail = `${lastStatus.detail} - the credential cannot write to this repository, so publishing and dispatching will fail`;
  }
  return lastStatus;
}

/**
 * Whether the credential can create content in the repository.
 *
 * Probed with a blob that nothing references: it is a real write attempt, so it
 * is the only way to tell a read-only installation token from a writable one,
 * and a dangling blob is garbage-collected by GitHub without touching a branch,
 * a commit or the working tree.
 */
async function probeWriteCapability(repo: string): Promise<boolean | null> {
  const cred = await resolveCredential();
  if (!cred.ok) return null;
  const res = await ghFetch(`/repos/${repo}/git/blobs`, config.githubTimeoutMs, {
    method: 'POST',
    token: cred.token,
    body: { content: 'probe', encoding: 'utf-8' },
  });
  if (res.ok) return true;
  // 403/404 mean the credential is authenticated but unauthorized to write;
  // anything else (network, 5xx) is inconclusive rather than a denial.
  if (res.status === 403 || res.status === 404) return false;
  return null;
}

/** The most recent probe result, without issuing a call. */
export function cachedGithubStatus(): GithubStatus {
  return lastStatus;
}

/**
 * Streams an artifact archive through the backend so the credential stays
 * server-side. Returns null when the integration is not usable, so the caller
 * can answer 404/503 rather than a fabricated download.
 */
export async function downloadArtifact(repo: string, artifactId: number): Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | null; contentType: string; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) {
    return { ok: false, status: 503, body: null, contentType: '', error: cred.error ?? 'no GitHub credential is configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.githubTimeoutMs);
  try {
    // The artifacts endpoint redirects to a signed URL; fetch follows it and
    // the Authorization header is dropped by the redirect target, which is the
    // intended behaviour.
    const res = await fetch(`${apiBase()}/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
      headers: headers(cred.token),
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

// ---------------------------------------------------------------------------
// Git Data API
//
// Used to publish a project workspace into the repository so a workflow run has
// something to build. Each call is authenticated with the same server-side
// credential and returns GitHub's own answer.
// ---------------------------------------------------------------------------

/** SHA at the head of a branch; an empty branch means the repository default. */
export async function getRepoBranchHead(repo: string, branch: string): Promise<{ ok: boolean; sha: string | null; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, sha: null, error: cred.error };
  if (!branch) {
    const res = await ghFetch(`/repos/${repo}`, config.githubTimeoutMs, { token: cred.token });
    if (!res.ok) return { ok: false, sha: null, error: res.error ?? `HTTP ${res.status}` };
    const def = String((res.body as { default_branch?: string }).default_branch ?? '');
    if (!def) return { ok: false, sha: null, error: 'the repository reports no default branch' };
    return getRepoBranchHead(repo, def);
  }
  const res = await ghFetch(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, config.githubTimeoutMs, { token: cred.token });
  if (!res.ok) return { ok: false, sha: null, error: res.error ?? `HTTP ${res.status}` };
  const sha = (res.body as { object?: { sha?: string } }).object?.sha ?? null;
  return { ok: !!sha, sha, error: sha ? undefined : 'the ref carried no sha' };
}

/** Tree sha of a commit, used as the base so a publish merges rather than replaces. */
export async function getRepoTreeSha(repo: string, commitSha: string): Promise<{ ok: boolean; sha: string | null; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, sha: null, error: cred.error };
  const res = await ghFetch(`/repos/${repo}/git/commits/${commitSha}`, config.githubTimeoutMs, { token: cred.token });
  if (!res.ok) return { ok: false, sha: null, error: res.error ?? `HTTP ${res.status}` };
  const sha = (res.body as { tree?: { sha?: string } }).tree?.sha ?? null;
  return { ok: !!sha, sha, error: sha ? undefined : 'commit response carried no tree sha' };
}

/** Name of the repository's default branch, as GitHub reports it. */
export async function getRepoDefaultBranch(repo: string): Promise<{ ok: boolean; branch: string | null; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, branch: null, error: cred.error };
  const res = await ghFetch(`/repos/${repo}`, config.githubTimeoutMs, { token: cred.token });
  if (!res.ok) return { ok: false, branch: null, error: res.error ?? `HTTP ${res.status}` };
  const branch = String((res.body as { default_branch?: string }).default_branch ?? '');
  return { ok: !!branch, branch: branch || null, error: branch ? undefined : 'the repository reports no default branch' };
}

/** Lists a tree's entries recursively, as GitHub returns them. */
export async function getRepoTreeEntries(repo: string, treeSha: string): Promise<{ ok: boolean; entries: Array<{ path: string; sha: string }>; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, entries: [], error: cred.error };
  const res = await ghFetch(`/repos/${repo}/git/trees/${treeSha}?recursive=1`, config.githubTimeoutMs, { token: cred.token });
  if (!res.ok) return { ok: false, entries: [], error: res.error ?? `HTTP ${res.status}` };
  const entries = (res.body as { tree?: Array<{ path?: string; sha?: string }> }).tree ?? [];
  return {
    ok: true,
    entries: entries
      .filter((e): e is { path: string; sha: string } => typeof e.path === 'string' && typeof e.sha === 'string'),
  };
}

/** Creates blobs in one request; GitHub accepts the batched form for each entry. */
export async function createBlobs(repo: string, blobs: Array<{ content: string; encoding?: string }>): Promise<{ ok: boolean; shas: string[]; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, shas: [], error: cred.error };
  const shas: string[] = [];
  for (const blob of blobs) {
    const res = await ghFetch(`/repos/${repo}/git/blobs`, config.githubTimeoutMs, {
      method: 'POST',
      body: { content: blob.content, encoding: blob.encoding ?? 'base64' },
      token: cred.token,
    });
    if (!res.ok) return { ok: false, shas, error: res.error ?? `HTTP ${res.status}` };
    const sha = (res.body as { sha?: string }).sha;
    if (!sha) return { ok: false, shas, error: 'blob response carried no sha' };
    shas.push(sha);
  }
  return { ok: true, shas };
}

export async function createTree(
  repo: string,
  entries: Array<{ path: string; mode: string; type: string; sha: string | null }>,
  baseTree?: string | null,
): Promise<{ ok: boolean; sha: string | null; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, sha: null, error: cred.error };
  // With a base tree GitHub merges our entries over the existing snapshot, so a
  // sparse publish does not delete the rest of the repository. A null sha on an
  // entry deletes that path, which is how the managed workflow is kept current.
  const body: Record<string, unknown> = { tree: entries };
  if (baseTree) body.base_tree = baseTree;
  const res = await ghFetch(`/repos/${repo}/git/trees`, config.githubTimeoutMs, {
    method: 'POST', body, token: cred.token,
  });
  if (!res.ok) return { ok: false, sha: null, error: res.error ?? `HTTP ${res.status}` };
  const sha = (res.body as { sha?: string }).sha ?? null;
  return { ok: !!sha, sha, error: sha ? undefined : 'tree response carried no sha' };
}

export async function createCommit(repo: string, input: { message: string; tree: string; parents: string[] }): Promise<{ ok: boolean; sha: string | null; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, sha: null, error: cred.error };
  const res = await ghFetch(`/repos/${repo}/git/commits`, config.githubTimeoutMs, {
    method: 'POST',
    body: { message: input.message, tree: input.tree, parents: input.parents },
    token: cred.token,
  });
  if (!res.ok) return { ok: false, sha: null, error: res.error ?? `HTTP ${res.status}` };
  const sha = (res.body as { sha?: string }).sha ?? null;
  return { ok: !!sha, sha, error: sha ? undefined : 'commit response carried no sha' };
}

/** Creates or fast-forwards a branch ref. Never force-pushes another branch. */
export async function updateRef(repo: string, branch: string, sha: string): Promise<{ ok: boolean; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, error: cred.error };
  const existing = await getRepoBranchHead(repo, branch);
  if (existing.ok) {
    const res = await ghFetch(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, config.githubTimeoutMs, {
      method: 'PATCH', body: { sha, force: false }, token: cred.token,
    });
    if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
    return { ok: true };
  }
  const res = await ghFetch(`/repos/${repo}/git/refs`, config.githubTimeoutMs, {
    method: 'POST', body: { ref: `refs/heads/${branch}`, sha }, token: cred.token,
  });
  if (!res.ok) return { ok: false, error: res.error ?? `HTTP ${res.status}` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Dispatch, polling and artifact retrieval
//
// These functions are the write path. They only ever describe what GitHub
// actually returned: `dispatchWorkflow` reports the HTTP status of the dispatch
// call, `getWorkflowRun` reports the run GitHub is currently tracking, and
// `fetchRunArtifact` returns the archive bytes. Deciding whether a build
// succeeded is done by the orchestrator below from the run conclusion plus a
// validated artifact, never from the dispatch response.
// ---------------------------------------------------------------------------

interface RunArtifact {
  id: number;
  name: string;
  sizeInBytes: number;
  expired: boolean;
}

/** A normalised view of one workflow run plus its artifacts. */
export interface RunSnapshot {
  id: number;
  runNumber: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headSha: string;
  headBranch: string;
  event: string;
  createdAt: string;
  updatedAt: string;
  artifacts: RunArtifact[];
}

function mapRunSnapshot(raw: Record<string, unknown>): RunSnapshot {
  return {
    id: Number(raw.id ?? 0),
    runNumber: Number(raw.run_number ?? 0),
    status: String(raw.status ?? 'unknown'),
    conclusion: raw.conclusion ? String(raw.conclusion) : null,
    htmlUrl: String(raw.html_url ?? ''),
    headSha: String(raw.head_sha ?? ''),
    headBranch: String(raw.head_branch ?? ''),
    event: String(raw.event ?? ''),
    createdAt: String(raw.created_at ?? ''),
    updatedAt: String(raw.updated_at ?? ''),
    artifacts: [],
  };
}

/**
 * Dispatches a workflow. Only the workflow file named by the server
 * configuration can be dispatched, so a request cannot ask for an arbitrary
 * workflow in the repository.
 */
export async function dispatchWorkflow(input: {
  repo: string;
  workflow: string;
  ref: string;
  inputs?: Record<string, string>;
}): Promise<{ ok: boolean; status: number; error?: string }> {
  if (input.workflow !== config.githubWorkflow) {
    return { ok: false, status: 400, error: `workflow "${input.workflow}" is not the configured build workflow` };
  }
  if (!input.repo || !/^[^/\s]+\/[^/\s]+$/.test(input.repo)) {
    return { ok: false, status: 400, error: 'a repository in owner/name form is required to dispatch a workflow' };
  }
  if (!input.ref) {
    return { ok: false, status: 400, error: 'a ref is required to dispatch a workflow' };
  }
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, status: 503, error: cred.error };

  const res = await ghFetch(
    `/repos/${input.repo}/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
    config.githubTimeoutMs,
    { method: 'POST', body: { ref: input.ref, inputs: input.inputs ?? {} }, token: cred.token },
  );
  // A dispatch answers 204 with no body. Anything else is a real failure the
  // caller must surface rather than treating as "queued".
  if (!res.ok) return { ok: false, status: res.status, error: res.error ?? `dispatch failed with HTTP ${res.status}` };
  return { ok: true, status: res.status };
}

/** Reads one run, including its artifacts. Null when the run cannot be read. */
export async function getWorkflowRun(repo: string, runId: number): Promise<{ ok: boolean; run: RunSnapshot | null; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, run: null, error: cred.error };
  const res = await ghFetch(`/repos/${repo}/actions/runs/${runId}`, config.githubTimeoutMs, { token: cred.token });
  if (!res.ok) return { ok: false, run: null, error: res.error ?? `HTTP ${res.status}` };
  const run = mapRunSnapshot(res.body as Record<string, unknown>);
  const artifacts = await ghFetch(`/repos/${repo}/actions/runs/${runId}/artifacts`, config.githubTimeoutMs, { token: cred.token });
  if (artifacts.ok) {
    const items = (artifacts.body as { artifacts?: Array<Record<string, unknown>> }).artifacts ?? [];
    run.artifacts = items.map((a) => ({
      id: Number(a.id ?? 0),
      name: String(a.name ?? ''),
      sizeInBytes: Number(a.size_in_bytes ?? 0),
      expired: Boolean(a.expired),
    }));
  }
  return { ok: true, run };
}

/** Lists the jobs of a run, which is what identifies the active stage. */
export async function getRunJobs(repo: string, runId: number): Promise<Array<{ name: string; status: string; conclusion: string | null }>> {
  const cred = await resolveCredential();
  if (!cred.ok) return [];
  const res = await ghFetch(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=50`, config.githubTimeoutMs, { token: cred.token });
  if (!res.ok) return [];
  const items = (res.body as { jobs?: Array<Record<string, unknown>> }).jobs ?? [];
  return items.map((j) => ({
    name: String(j.name ?? ''),
    status: String(j.status ?? ''),
    conclusion: j.conclusion ? String(j.conclusion) : null,
  }));
}

/** Lists the most recent runs of the configured workflow, newest first. */
export async function listWorkflowRuns(repo: string, workflow: string, limit = 10): Promise<{ ok: boolean; runs: RunSnapshot[]; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, runs: [], error: cred.error };
  const res = await ghFetch(
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${limit}`,
    config.githubTimeoutMs,
    { token: cred.token },
  );
  if (!res.ok) return { ok: false, runs: [], error: res.error ?? `HTTP ${res.status}` };
  const items = (res.body as { workflow_runs?: Array<Record<string, unknown>> }).workflow_runs ?? [];
  return { ok: true, runs: items.map(mapRunSnapshot) };
}

/** Cancels a run that is still in progress. */
export async function cancelWorkflowRun(repo: string, runId: number): Promise<{ ok: boolean; status: number; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, status: 503, error: cred.error };
  const res = await ghFetch(`/repos/${repo}/actions/runs/${runId}/cancel`, config.githubTimeoutMs, {
    method: 'POST', token: cred.token,
  });
  if (!res.ok) return { ok: false, status: res.status, error: res.error ?? `HTTP ${res.status}` };
  return { ok: true, status: res.status };
}

/** Downloads a run's log text, or null when GitHub has none yet. */
export async function fetchRunLogs(repo: string, runId: number): Promise<{ ok: boolean; text: string; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, text: '', error: cred.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.githubTimeoutMs);
  try {
    const res = await fetch(`${apiBase()}/repos/${repo}/actions/runs/${runId}/logs`, {
      headers: headers(cred.token),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    // GitHub serves a zip holding one .txt per job. It is unpacked in-process so
    // the caller gets the actual log text rather than a description of a blob.
    const text = extractRunLogText(buf);
    if (text === null) {
      return { ok: true, text: `GitHub returned a ${buf.length}-byte log archive for run ${runId} that could not be read as a zip.` };
    }
    return { ok: true, text };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, text: '', error: aborted ? `timeout after ${config.githubTimeoutMs}ms` : redact(err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unpacks a GitHub run-log archive into readable text, newest job last.
 * Returns null when the bytes are not a zip, so the caller can say so instead of
 * presenting binary data as a log.
 */
export function extractRunLogText(buf: Buffer, maxTotalBytes = 2 * 1024 * 1024): string | null {
  const read = readZipEntries(buf);
  if (!read.ok) return null;
  const parts: string[] = [];
  let total = 0;
  // Job log names are `0_<job>.txt`, `1_<job>.txt`, so a plain sort is run order.
  const names = read.entries.map((e) => e.name).filter((n) => n.endsWith('.txt')).sort();
  for (const name of names) {
    const raw = readZipEntry(buf, name);
    if (!raw) continue;
    const remaining = maxTotalBytes - total;
    if (remaining <= 0) {
      parts.push(`... log truncated at ${maxTotalBytes} bytes ...`);
      break;
    }
    const slice = raw.length > remaining ? raw.subarray(0, remaining) : raw;
    const text = redact(slice.toString('utf8'));
    total += slice.length;
    parts.push(`===== ${name} =====\n${text}`);
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

/** Downloads the bytes of one artifact, following the signed redirect. */
export async function fetchArtifactBytes(repo: string, artifactId: number): Promise<{ ok: boolean; bytes: Buffer | null; error?: string }> {
  const cred = await resolveCredential();
  if (!cred.ok) return { ok: false, bytes: null, error: cred.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.githubTimeoutMs);
  try {
    const res = await fetch(`${apiBase()}/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
      headers: headers(cred.token),
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, bytes: null, error: `HTTP ${res.status}` };
    return { ok: true, bytes: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { ok: false, bytes: null, error: aborted ? `timeout after ${config.githubTimeoutMs}ms` : redact(err instanceof Error ? err.message : String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts the first APK member from an artifact archive. Uploaded artifacts
 * are zips of the files the workflow wrote, so the APK is one member among
 * possibly several (BUILD_INFO.txt, SHA256SUMS.txt).
 */
export function extractApkFromArtifact(archive: Buffer): { ok: boolean; fileName: string | null; bytes: Buffer | null; error?: string } {
  const parsed = readZipEntries(archive);
  if (!parsed.ok) return { ok: false, fileName: null, bytes: null, error: parsed.error };
  const apk = parsed.entries
    .filter((e) => /\.apk$/i.test(e.name) && !e.name.endsWith('/'))
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)[0];
  if (!apk) return { ok: false, fileName: null, bytes: null, error: 'artifact archive contains no .apk member' };
  const bytes = readZipEntry(archive, apk.name);
  if (!bytes) return { ok: false, fileName: null, bytes: null, error: `could not read ${apk.name} from the artifact archive` };
  return { ok: true, fileName: apk.name.split('/').pop() ?? apk.name, bytes };
}
