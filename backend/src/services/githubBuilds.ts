/**
 * GitHub Actions build orchestration.
 *
 * This is the write path behind the "Build on GitHub Actions" button. It
 * dispatches the configured workflow, polls the run GitHub is actually
 * tracking, and only records `success` once the run concluded successfully
 * *and* an APK artifact was downloaded and validated as a real APK. Anything
 * else is recorded as the failure it was.
 *
 * The remote run id is filled in as soon as it is discovered so the UI can show
 * `queued`/`running` truthfully; polling continues in the background under the
 * shared job queue, which bounds concurrency and total time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import { sha256Hex } from '../lib/hash.ts';
import { query } from '../db/pool.ts';
import { validateApkBuffer, type ApkValidation } from '../lib/apkZip.ts';
import {
  credentialKind,
  dispatchWorkflow,
  extractApkFromArtifact,
  fetchArtifactBytes,
  getRunJobs,
  getWorkflowRun,
  listWorkflowRuns,
  cancelWorkflowRun,
  type RunArtifact,
  type RunSnapshot,
} from './githubActions.ts';
import { jobQueue } from './jobQueue.ts';
import { logEvent } from './eventBus.ts';

/** Normalised states shown in the UI. */
export type GithubBuildStatus =
  | 'queued'
  | 'running'
  | 'testing'
  | 'building'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'not_configured'
  | 'blocked';

export interface GithubBuildView {
  id: string;
  projectId: string;
  repo: string;
  workflow: string;
  ref: string;
  runId: number | null;
  runNumber: number | null;
  htmlUrl: string | null;
  status: GithubBuildStatus;
  conclusion: string | null;
  apk: {
    name: string;
    sizeBytes: number;
    sha256: string;
    packageName: string | null;
    versionName: string | null;
    versionCode: string | null;
    valid: boolean;
  } | null;
  error: string | null;
  logTail: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface GithubRunRow {
  id: string;
  project_id: string;
  owner_id: string;
  repo: string;
  workflow: string;
  ref: string;
  run_id: string | number | null;
  run_number: number | null;
  html_url: string | null;
  status: string;
  conclusion: string | null;
  apk_name: string | null;
  apk_size_bytes: string | number | null;
  apk_sha256: string | null;
  apk_package: string | null;
  apk_version_name: string | null;
  apk_version_code: string | null;
  apk_valid: boolean;
  log: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

const TERMINAL: GithubBuildStatus[] = ['success', 'failed', 'cancelled', 'timeout'];

/**
 * The ref a build runs against. The workspace is published to this branch, so
 * the dispatch and the publish must agree on it or the runner would check out
 * something else. Shared with the sync service through config.
 */
export function defaultBuildRef(): string {
  return config.githubWorkflowRef || 'my-ai-studio-build';
}

export function isTerminal(status: GithubBuildStatus): boolean {
  return TERMINAL.includes(status);
}

function toView(row: GithubRunRow): GithubBuildView {
  return {
    id: row.id,
    projectId: row.project_id,
    repo: row.repo,
    workflow: row.workflow,
    ref: row.ref,
    runId: row.run_id === null ? null : Number(row.run_id),
    runNumber: row.run_number,
    htmlUrl: row.html_url,
    status: row.status as GithubBuildStatus,
    conclusion: row.conclusion,
    apk: row.apk_name
      ? {
          name: row.apk_name,
          sizeBytes: Number(row.apk_size_bytes ?? 0),
          sha256: row.apk_sha256 ?? '',
          packageName: row.apk_package,
          versionName: row.apk_version_name,
          versionCode: row.apk_version_code,
          valid: row.apk_valid,
        }
      : null,
    error: row.error,
    logTail: row.log.slice(-40000),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

/**
 * Maps a run snapshot to a display state. `testing` and `building` come from the
 * job names GitHub reports, so the stage shown is the stage actually running.
 * A completed run is never called success here: the caller additionally
 * requires a validated APK artifact before writing `success`.
 */
export function deriveStatus(run: RunSnapshot, jobs: Array<{ name: string; status: string }>): GithubBuildStatus {
  if (run.status === 'queued' || run.status === 'waiting' || run.status === 'requested' || run.status === 'pending') {
    return 'queued';
  }
  if (run.status === 'in_progress') {
    const active = jobs.find((j) => j.status === 'in_progress');
    if (active && /build|assemble|apk/i.test(active.name)) return 'building';
    return 'testing';
  }
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return 'success';
    if (run.conclusion === 'cancelled') return 'cancelled';
    if (run.conclusion === 'timed_out') return 'timeout';
    return 'failed';
  }
  return 'running';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistBlocked(
  input: { projectId: string; ownerId: string; repo?: string; workflow: string; ref: string },
  status: GithubBuildStatus,
  detail: string,
): Promise<GithubBuildView> {
  const inserted = await query<GithubRunRow>(
    `INSERT INTO github_runs (project_id, owner_id, repo, workflow, ref, status, error, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING *`,
    [input.projectId, input.ownerId, input.repo ?? '(unset)', input.workflow, input.ref, status, detail],
  );
  logger.warn('github build not started', { projectId: input.projectId, status, detail });
  return toView(inserted.rows[0]);
}

/**
 * Starts a build. Records a row immediately, dispatches, and returns as soon as
 * the dispatch is accepted; the run is then followed in the background. A
 * configuration problem is recorded as `not_configured`/`blocked` rather than
 * thrown, so the UI can show the honest state instead of a generic error.
 */
export async function startGithubBuild(input: {
  projectId: string;
  ownerId: string;
  repo?: string;
  branch?: string;
  workflow?: string;
}): Promise<GithubBuildView> {
  const repo = input.repo || config.githubRepo;
  const workflow = input.workflow || config.githubWorkflow;
  const ref = input.branch || defaultBuildRef();

  if (credentialKind() === 'none') {
    return persistBlocked({ ...input, repo, workflow, ref }, 'not_configured',
      'no GitHub credential is configured on the server (store one in Settings, or set MY_AI_STUDIO_GITHUB_TOKEN, or GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY and GITHUB_INSTALLATION_ID)');
  }
  if (!repo) {
    return persistBlocked({ ...input, repo, workflow, ref }, 'not_configured',
      'no repository is configured (set GITHUB_REPO or pass a repository for this project)');
  }
  if (workflow !== config.githubWorkflow) {
    return persistBlocked({ ...input, repo, workflow, ref }, 'blocked',
      `workflow "${workflow}" is not the configured build workflow`);
  }

  const inserted = await query<GithubRunRow>(
    `INSERT INTO github_runs (project_id, owner_id, repo, workflow, ref, status)
     VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING *`,
    [input.projectId, input.ownerId, repo, workflow, ref],
  );
  const row = inserted.rows[0];

  const dispatch = await dispatchWorkflow({ repo, workflow, ref, inputs: {} });
  if (!dispatch.ok) {
    const status: GithubBuildStatus = dispatch.status === 503 ? 'not_configured' : 'failed';
    await finish(row.id, input.projectId, status, null, dispatch.error ?? `dispatch failed with HTTP ${dispatch.status}`, true);
    return (await getGithubBuild(row.id, input.projectId))!;
  }

  logEvent(input.projectId, 'build_log', 'info', `GitHub Actions build dispatched (${repo} · ${workflow} @ ${ref})`);

  void jobQueue
    .submit({
      id: `github-build-${row.id}`,
      timeoutMs: config.githubBuildTimeoutMs,
      run: async (signal) => pollRun(row.id, input.projectId, repo, workflow, ref, signal),
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = message.includes('JOB_TIMEOUT');
      await finish(row.id, input.projectId, timedOut ? 'timeout' : 'failed', null, message, true);
    });

  return (await getGithubBuild(row.id, input.projectId))!;
}

/** Finds the run GitHub created for our dispatch, then follows it. */
async function pollRun(
  runRowId: string, projectId: string, repo: string, workflow: string, ref: string, signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + config.githubBuildTimeoutMs;
  let runId: number | null = null;

  // The dispatch response carries no run id, so the newest run for the branch is
  // adopted. Branch and event are checked so an unrelated run cannot be claimed.
  while (runId === null) {
    if (signal.aborted) return;
    if (Date.now() > deadline) {
      await finish(runRowId, projectId, 'timeout', null, 'no workflow run appeared before the timeout', true);
      return;
    }
    const listed = await listWorkflowRuns(repo, workflow, 10);
    if (listed.ok) {
      const candidate = listed.runs.find(
        (r) => r.headBranch === ref && (r.event === 'workflow_dispatch' || r.event === 'push'),
      );
      if (candidate) {
        runId = candidate.id;
        await query(
          `UPDATE github_runs SET run_id = $2, run_number = $3, html_url = $4, updated_at = now() WHERE id = $1`,
          [runRowId, candidate.id, candidate.runNumber, candidate.htmlUrl],
        );
        logEvent(projectId, 'build_log', 'info', `GitHub run ${candidate.runNumber} detected (id ${candidate.id})`);
        break;
      }
    } else if (listed.error) {
      logger.warn('github run discovery failed', { repo, error: listed.error });
    }
    await sleep(config.githubBuildPollMs);
  }

  for (;;) {
    if (signal.aborted) {
      await finish(runRowId, projectId, 'cancelled', null, 'cancelled', false);
      return;
    }
    if (Date.now() > deadline) {
      await finish(runRowId, projectId, 'timeout', null,
        `run ${runId} did not complete within ${config.githubBuildTimeoutMs}ms`, true);
      return;
    }

    const snap = await getWorkflowRun(repo, runId);
    if (!snap.ok || !snap.run) {
      logger.warn('github run poll failed', { repo, runId, error: snap.error ?? null });
      await sleep(config.githubBuildPollMs);
      continue;
    }
    const jobs = await getRunJobs(repo, runId);
    const status = deriveStatus(snap.run, jobs);

    await query(
      `UPDATE github_runs SET status = $2, conclusion = $3, run_number = $4, html_url = $5, updated_at = now() WHERE id = $1`,
      [runRowId, status, snap.run.conclusion, snap.run.runNumber, snap.run.htmlUrl],
    );

    if (!TERMINAL.includes(status)) {
      logEvent(projectId, 'build_log', 'info', `GitHub run ${snap.run.runNumber}: ${status}`);
      await sleep(config.githubBuildPollMs);
      continue;
    }
    if (status !== 'success') {
      await finish(runRowId, projectId, status, snap.run.conclusion,
        `workflow concluded ${snap.run.conclusion ?? status}`, true);
      return;
    }
    await collectArtifact(runRowId, projectId, repo, snap.run);
    return;
  }
}

/**
 * Proves the run produced a usable APK. A success conclusion without a valid
 * artifact is recorded as a failure, because the APK is the point of the run.
 */
async function collectArtifact(runRowId: string, projectId: string, repo: string, run: RunSnapshot): Promise<void> {
  const candidates = run.artifacts.filter((a) => !a.expired && a.sizeInBytes > 0);
  if (candidates.length === 0) {
    await finish(runRowId, projectId, 'failed', run.conclusion, 'run succeeded but no artifact was uploaded', true);
    return;
  }

  const selected = await selectApkArtifact(candidates, (id) => fetchArtifactBytes(repo, id));
  if (!selected.ok) {
    await finish(runRowId, projectId, 'failed', run.conclusion,
      `no artifact in this run contained a usable APK (${selected.problems.join('; ')})`, true);
    return;
  }

  await storeApk(runRowId, projectId, run, selected.artifact!, selected.bytes!,
    selected.fileName ?? null, selected.validation!);
}

/**
 * Picks the first candidate artifact that actually holds a usable APK.
 *
 * A run usually uploads more than one artifact (the APK, test reports, ...), and
 * GitHub returns them in no guaranteed order: the APK came first in one observed
 * run and second in the next. Selecting by position therefore produced different
 * results from identical workflows. Every candidate is inspected instead, so
 * neither ordering nor artifact naming can change the outcome.
 */
export async function selectApkArtifact(
  candidates: RunArtifact[],
  fetchBytes: (artifactId: number) => Promise<{ ok: boolean; bytes: Buffer | null; error?: string }>,
): Promise<{
  ok: boolean;
  artifact?: RunArtifact;
  bytes?: Buffer;
  fileName?: string | null;
  validation?: ApkValidation;
  problems: string[];
}> {
  const problems: string[] = [];
  for (const artifact of candidates) {
    const fetched = await fetchBytes(artifact.id);
    if (!fetched.ok || !fetched.bytes) {
      problems.push(`${artifact.name}: download failed (${fetched.error ?? 'unknown error'})`);
      continue;
    }
    const apk = extractApkFromArtifact(fetched.bytes);
    if (!apk.ok || !apk.bytes) {
      problems.push(`${artifact.name}: ${apk.error ?? 'no usable APK'}`);
      continue;
    }
    const validation = validateApkBuffer(apk.bytes);
    if (!validation.valid) {
      problems.push(`${artifact.name}: invalid APK (${validation.error ?? 'invalid'})`);
      continue;
    }
    return { ok: true, artifact, bytes: apk.bytes, fileName: apk.fileName, validation, problems };
  }
  return { ok: false, problems };
}

/** Persists a validated APK and records the run as successful. */
async function storeApk(
  runRowId: string, projectId: string, run: RunSnapshot,
  artifact: RunArtifact, bytes: Buffer, apkFileName: string | null,
  validation: ApkValidation,
): Promise<void> {
  const digest = sha256Hex(bytes);
  const dir = githubStorageDir(runRowId);
  await fs.mkdir(dir, { recursive: true });
  const fileName = apkFileName ?? 'app-debug.apk';
  await fs.writeFile(path.join(dir, fileName), bytes);

  await query(
    `UPDATE github_runs SET status = 'success', conclusion = $2, apk_name = $3, apk_size_bytes = $4,
       apk_sha256 = $5, apk_artifact_id = $6, apk_package = $7, apk_version_name = $8, apk_version_code = $9,
       apk_valid = true, updated_at = now(), finished_at = now()
     WHERE id = $1`,
    [
      runRowId, run.conclusion, fileName, bytes.length, digest, artifact.id,
      validation.packageName, validation.versionName, validation.versionCode,
    ],
  );
  logEvent(projectId, 'build_log', 'info',
    `GitHub Actions build succeeded · ${fileName} · ${bytes.length} bytes · sha256 ${digest.slice(0, 16)}…`);
}

/** Directory holding APKs fetched from GitHub, one per tracked build. */
function githubStorageDir(runRowId: string): string {
  return path.join(config.storageRoot, 'github', runRowId);
}

async function finish(
  runRowId: string, projectId: string, status: GithubBuildStatus,
  conclusion: string | null, detail: string, isError: boolean,
): Promise<void> {
  const trimmed = detail.slice(0, 4000);
  await query(
    `UPDATE github_runs SET status = $2, conclusion = $3, error = $4, finished_at = now(), updated_at = now(),
       log = CASE WHEN $5 THEN log || CASE WHEN log = '' THEN '' ELSE E'\n' END || $4 ELSE log END
     WHERE id = $1`,
    [runRowId, status, conclusion, trimmed, isError],
  );
  logEvent(projectId, 'build_log', isError ? 'error' : 'info', `GitHub Actions build ${status}: ${trimmed}`);
}

/** Reads one tracked build, scoped to a project so ownership is enforced. */
export async function getGithubBuild(id: string, projectId: string): Promise<GithubBuildView | null> {
  const res = await query<GithubRunRow>(
    `SELECT * FROM github_runs WHERE id = $1 AND project_id = $2`, [id, projectId],
  );
  const row = res.rows[0];
  return row ? toView(row) : null;
}

/** Recent GitHub builds for a project, newest first. */
export async function listGithubBuilds(projectId: string, limit = 20): Promise<GithubBuildView[]> {
  const res = await query<GithubRunRow>(
    `SELECT * FROM github_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`, [projectId, limit],
  );
  return res.rows.map(toView);
}

/** Latest successful GitHub build carrying a validated APK. */
export async function latestGithubApk(projectId: string): Promise<GithubBuildView | null> {
  const res = await query<GithubRunRow>(
    `SELECT * FROM github_runs WHERE project_id = $1 AND status = 'success' AND apk_valid = true
     ORDER BY created_at DESC LIMIT 1`, [projectId],
  );
  const row = res.rows[0];
  return row ? toView(row) : null;
}

/**
 * Path of the stored APK for a tracked build. Returns null unless the row is a
 * verified success, so a caller can never serve a file from a failed run.
 */
export async function githubApkPath(id: string, projectId: string): Promise<string | null> {
  const res = await query<GithubRunRow>(
    `SELECT * FROM github_runs WHERE id = $1 AND project_id = $2 AND status = 'success' AND apk_valid = true`,
    [id, projectId],
  );
  const row = res.rows[0];
  if (!row || !row.apk_name) return null;
  const candidate = path.join(githubStorageDir(row.id), row.apk_name);
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** Cancels a tracked build: asks GitHub, then records the outcome. */
export async function cancelGithubBuild(id: string, projectId: string): Promise<{ ok: boolean; error?: string }> {
  const row = await getGithubBuild(id, projectId);
  if (!row) return { ok: false, error: 'build not found' };
  if (isTerminal(row.status)) return { ok: false, error: `build already ${row.status}` };

  if (row.runId) {
    const res = await cancelWorkflowRun(row.repo, row.runId);
    // GitHub answers 409 when the run already finished; that is not a failure of
    // the cancel request itself.
    if (!res.ok && res.status !== 409) {
      return { ok: false, error: res.error ?? `cancel failed with HTTP ${res.status}` };
    }
  }
  jobQueue.cancel(`github-build-${id}`);
  await finish(id, projectId, 'cancelled', null, 'cancelled by user', false);
  return { ok: true };
}
