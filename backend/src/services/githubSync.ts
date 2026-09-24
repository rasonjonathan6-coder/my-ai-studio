/**
 * Pushes a project workspace to GitHub so Actions has something to build.
 *
 * A GitHub-hosted runner checks out the repository, not our server, so the
 * project's files have to exist in the repository before a build can mean
 * anything. This uses the Git Data API (blobs -> tree -> commit -> ref) rather
 * than shelling out to git: no working copy, no credentials on disk, and the
 * push is a single atomic ref update.
 *
 * Only source files are pushed. Build output, dependency caches, VCS metadata
 * and anything that looks like a secret are filtered out, so a build can never
 * publish a credential into the repository or an artifact.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import { redact } from '../lib/logger.ts';
import { getRepoBranchHead, createBlobs, createTree, createCommit, updateRef, getRepoTreeSha } from './githubActions.ts';
import { WorkspaceService } from './workspace.ts';
import { defaultBuildRef } from './githubBuilds.ts';

/**
 * The workflow this deployment dispatches. It is installed into the target
 * repository on every publish, so a repository that was never set up by hand
 * still has the exact workflow the server dispatches. The copy in this
 * repository is the single source of truth.
 */
const MANAGED_WORKFLOW_SOURCE = path.resolve(
  fileURLToPath(new URL('../../../.github/workflows/android-build.yml', import.meta.url)),
);

/** Where the managed workflow is written in the target repository. */
function managedWorkflowPath(): string {
  return path.posix.join('.github', 'workflows', config.githubWorkflow);
}

/** Directories never pushed: build output, caches and VCS metadata. */
const SKIP_DIRS = new Set([
  '.git', '.gradle', 'build', 'node_modules', 'dist', 'out', '.idea', '.vscode',
  '__pycache__', '.pytest_cache', 'workspace-data', 'release',
]);

/** File names never pushed: local environment and secret material. */
const SKIP_FILE_PATTERNS = [
  /^\.env$/i, /^\.env\./i, /secret/i, /credential/i, /\.pem$/i, /\.key$/i,
  /^id_rsa/i, /\.keystore$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^google-services\.json$/i,
];

/** Content patterns that mean a file must not be published. */
const SECRET_CONTENT = [
  /sk-or-[A-Za-z0-9_-]{10,}/,
  /OPENROUTER_API_KEY\s*=\s*["']?[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{16,}["']/i,
];

export interface SyncResult {
  ok: boolean;
  repo: string;
  branch: string;
  commitSha: string | null;
  filesPushed: number;
  skipped: string[];
  error?: string;
}

/** Collects the files to push, applying the exclusion rules above. */
export async function collectPublishableFiles(root: string, maxFiles = 2000, maxBytes = 512 * 1024): Promise<{ files: Array<{ rel: string; content: Buffer }>; skipped: string[] }> {
  const files: Array<{ rel: string; content: Buffer }> = [];
  const skipped: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) { skipped.push(`${rel} (symlink)`); continue; }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) { skipped.push(`${rel}/ (excluded directory)`); continue; }
        await walk(abs);
        continue;
      }
      if (SKIP_FILE_PATTERNS.some((p) => p.test(entry.name))) { skipped.push(`${rel} (secret-like name)`); continue; }
      let stat;
      try { stat = await fs.lstat(abs); } catch { continue; }
      if (stat.size > maxBytes) { skipped.push(`${rel} (${stat.size} bytes exceeds ${maxBytes})`); continue; }
      let content: Buffer;
      try { content = await fs.readFile(abs); } catch { skipped.push(`${rel} (unreadable)`); continue; }
      // Binary files are still publishable; only text is pattern-scanned.
      const text = content.toString('utf8');
      if (!text.includes('\u0000') && SECRET_CONTENT.some((p) => p.test(text))) {
        skipped.push(`${rel} (contains a secret-like value)`);
        continue;
      }
      files.push({ rel, content });
    }
  }

  await walk(root);
  return { files, skipped };
}

/**
 * Publishes the workspace to `branch` and returns the new commit. When the
 * branch does not exist yet it is created from the repository's default branch,
 * so the first build of a project works without manual setup.
 */
export async function syncWorkspaceToRepo(input: {
  projectId: string;
  repo?: string;
  branch?: string;
  message?: string;
}): Promise<SyncResult> {
  const repo = input.repo || config.githubRepo || '';
  const branch = input.branch || defaultBuildRef();
  const empty: SyncResult = { ok: false, repo, branch, commitSha: null, filesPushed: 0, skipped: [] };
  if (!repo) return { ...empty, error: 'no repository configured (set GITHUB_REPO or pass a repository)' };

  const ws = new WorkspaceService(input.projectId);
  const root = await ws.ensure();
  const { files, skipped } = await collectPublishableFiles(root);
  if (files.length === 0) {
    return { ...empty, skipped, error: 'the project has no publishable files' };
  }

  // Base: the branch head when it exists, otherwise the default branch head.
  let baseCommit: string | null = null;
  let baseTree: string | null = null;
  const head = await getRepoBranchHead(repo, branch);
  if (head.ok && head.sha) {
    baseCommit = head.sha;
    const tree = await getRepoTreeSha(repo, head.sha);
    baseTree = tree.sha;
  } else {
    const fallback = await getRepoBranchHead(repo, '');
    if (!fallback.ok || !fallback.sha) {
      return { ...empty, skipped, error: `could not read the repository's default branch: ${fallback.error ?? 'unknown'}` };
    }
    baseCommit = fallback.sha;
    const tree = await getRepoTreeSha(repo, fallback.sha);
    baseTree = tree.sha;
  }

  // The managed workflow is published alongside the project so the repository
  // always holds the exact workflow the server will dispatch.
  const workflow = await readManagedWorkflow();
  if (!workflow.ok) return { ...empty, skipped, error: workflow.error };

  const blobs = await createBlobs(
    repo,
    [...files, { rel: managedWorkflowPath(), content: workflow.content }].map((f) => ({ content: f.content.toString('base64') })),
  );
  if (!blobs.ok) return { ...empty, skipped, error: `blob creation failed: ${blobs.error ?? 'unknown'}` };

  const treeEntries: Array<{ path: string; mode: string; type: string; sha: string | null }> = [
    ...files.map((f, i) => ({ path: f.rel, mode: '100644', type: 'blob', sha: blobs.shas[i] })),
    { path: managedWorkflowPath(), mode: '100644', type: 'blob', sha: blobs.shas[files.length] },
  ];
  const tree = await createTree(repo, treeEntries, baseTree);
  if (!tree.ok || !tree.sha) return { ...empty, skipped, error: `tree creation failed: ${tree.error ?? 'unknown'}` };

  const message = input.message
    ?? `My AI Studio: sync project ${input.projectId} (${files.length} files)`;
  const commit = await createCommit(repo, { message, tree: tree.sha, parents: baseCommit ? [baseCommit] : [] });
  if (!commit.ok || !commit.sha) return { ...empty, skipped, error: `commit creation failed: ${commit.error ?? 'unknown'}` };

  const ref = await updateRef(repo, branch, commit.sha);
  if (!ref.ok) return { ...empty, skipped, error: `ref update failed: ${ref.error ?? 'unknown'}` };

  logger.info('workspace synced to github', {
    projectId: input.projectId, repo, branch, files: files.length, commit: commit.sha.slice(0, 12),
    workflow: managedWorkflowPath(),
  });
  return {
    ok: true, repo, branch, commitSha: commit.sha,
    filesPushed: files.length, skipped,
  };
}

/**
 * Reads the workflow to install. Failure to find it is reported rather than
 * skipped: a repository without the workflow cannot be dispatched, and the
 * caller must not be told the publish succeeded.
 */
async function readManagedWorkflow(): Promise<{ ok: boolean; content: Buffer; error?: string }> {
  try {
    return { ok: true, content: await fs.readFile(MANAGED_WORKFLOW_SOURCE) };
  } catch {
    return {
      ok: false, content: Buffer.alloc(0),
      error: `the managed workflow is missing from this deployment (${MANAGED_WORKFLOW_SOURCE}); cannot publish a repository that can be dispatched`,
    };
  }
}

// Kept so callers can log a sync failure without risking a secret in the text.
export function safeSyncError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
}
