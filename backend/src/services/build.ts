/**
 * Build service. Detects the real build system, runs it, then verifies that the
 * expected artifact exists on disk. If Gradle exits 0 but no APK is present the
 * build is reported as FAILED, because the APK genuinely is not there.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/pool.ts';
import { runCommand, toolchainEnv } from './commandRunner.ts';
import { WorkspaceService } from './workspace.ts';
import { logEvent } from './eventBus.ts';
import { inspectApk, type ApkInspection } from './apkInspect.ts';
import { scanProject, type ScanResult } from './securityScan.ts';
import { sha256File } from '../lib/hash.ts';
import { config } from '../config/index.ts';
import { logger } from '../lib/logger.ts';

export type BuildTarget = 'debug' | 'release' | 'generic';

export interface BuildResult {
  id: string;
  kind: 'generic' | 'android' | 'node';
  target: BuildTarget;
  status: 'succeeded' | 'failed' | 'timeout';
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  log: string;
  apk: { path: string; relPath: string; sizeBytes: number; sha256: string } | null;
  inspection: ApkInspection | null;
  security: ScanResult | null;
  error: string | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Search the real filesystem (up to a bounded depth) for the built APK. */
export async function findApk(root: string, target: BuildTarget): Promise<string | null> {
  const candidates = target === 'release'
    ? [
        'app/build/outputs/apk/release/app-release.apk',
        'app/build/outputs/apk/release/app-release-unsigned.apk',
      ]
    : [
        'app/build/outputs/apk/debug/app-debug.apk',
      ];
  for (const rel of candidates) {
    const abs = path.join(root, rel);
    if (await exists(abs)) return abs;
  }
  // Fall back to a bounded recursive scan so renamed modules are still found.
  const found = await findApkRecursive(root, 0, 6);
  return found;
}

async function findApkRecursive(dir: string, depth: number, maxDepth: number): Promise<string | null> {
  if (depth > maxDepth) return null;
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dirent of dirents) {
    if (dirent.name === 'node_modules' || dirent.name === '.git') continue;
    const abs = path.join(dir, dirent.name);
    if (dirent.isFile() && dirent.name.endsWith('.apk')) return abs;
    if (dirent.isDirectory()) {
      const nested = await findApkRecursive(abs, depth + 1, maxDepth);
      if (nested) return nested;
    }
  }
  return null;
}

async function hasGradleProject(root: string): Promise<{ has: boolean; gradlew: boolean }> {
  const gradlew = await exists(path.join(root, 'gradlew'));
  if (gradlew) return { has: true, gradlew: true };
  if (await exists(path.join(root, 'settings.gradle.kts'))) return { has: true, gradlew: false };
  if (await exists(path.join(root, 'settings.gradle'))) return { has: true, gradlew: false };
  return { has: false, gradlew: false };
}

/** Uses ./gradlew when present, otherwise falls back to a system gradle. */
async function gradleInvocation(root: string, task: string): Promise<{ command: string; note: string | null }> {
  const project = await hasGradleProject(root);
  if (!project.has) return { command: '', note: 'no gradle project detected' };
  if (project.gradlew) return { command: `./gradlew ${task} --console=plain --no-daemon`, note: null };
  const systemGradle = await exists(path.join(root, 'gradle', 'wrapper', 'gradle-wrapper.jar'));
  if (!systemGradle) {
    return {
      command: `gradle ${task} --console=plain --no-daemon`,
      note: 'gradle-wrapper.jar is absent, falling back to the system gradle binary',
    };
  }
  return { command: `gradle ${task} --console=plain --no-daemon`, note: null };
}

export async function detectBuild(input: { projectId: string; target: BuildTarget }): Promise<{
  kind: 'generic' | 'android' | 'node';
  command: string | null;
  reason?: string;
}> {
  const ws = new WorkspaceService(input.projectId);
  const root = await ws.ensure();

  const project = await hasGradleProject(root);
  if (project.has) {
    const task = input.target === 'release' ? 'assembleRelease' : 'assembleDebug';
    const invocation = await gradleInvocation(root, task);
    if (invocation.note) logger.warn('gradle wrapper fallback', { projectId: input.projectId, note: invocation.note });
    return { kind: 'android', command: invocation.command, ...(invocation.note ? { reason: invocation.note } : {}) };
  }

  if (await exists(path.join(root, 'package.json'))) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      if (pkg.scripts?.build) return { kind: 'node', command: 'npm run build' };
      return { kind: 'node', command: null, reason: 'package.json has no "build" script' };
    } catch {
      return { kind: 'node', command: null, reason: 'package.json is not valid JSON' };
    }
  }

  return { kind: 'generic', command: null, reason: 'no gradlew wrapper or package.json build script found' };
}

export async function runBuild(input: {
  projectId: string;
  ownerId: string;
  agentRunId?: string | null;
  target?: BuildTarget;
  runSecurityScan?: boolean;
}): Promise<BuildResult> {
  const target = input.target ?? 'debug';
  const ws = new WorkspaceService(input.projectId);
  const root = await ws.ensure();
  const detection = await detectBuild({ projectId: input.projectId, target });

  const buildRow = await query<{ id: string }>(
    `INSERT INTO builds (project_id, agent_run_id, owner_id, kind, target, status, command)
     VALUES ($1, $2, $3, $4, $5, 'running', $6) RETURNING id`,
    [input.projectId, input.agentRunId ?? null, input.ownerId, detection.kind, target, detection.command],
  );
  const buildId = buildRow.rows[0].id;

  if (!detection.command) {
    const error = detection.reason ?? 'no build command detected';
    await query(
      `UPDATE builds SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`,
      [buildId, error],
    );
    logEvent(input.projectId, 'build_log', 'error', `BUILD UNDETECTABLE: ${error}`);
    return {
      id: buildId, kind: detection.kind, target, status: 'failed', command: null, exitCode: null,
      durationMs: 0, log: '', apk: null, inspection: null, security: null, error,
    };
  }

  logEvent(input.projectId, 'build_log', 'info', `building (${detection.kind}): ${detection.command}`);

  const result = await runCommand({
    cwd: root,
    command: detection.command,
    timeoutMs: config.buildTimeoutMs,
    env: await toolchainEnv(),
    onChunk: (stream, text) => logEvent(input.projectId, 'build_log', stream === 'stderr' ? 'warn' : 'info', text),
  });

  const log = `${result.stdout}\n${result.stderr}`;
  let status: BuildResult['status'] = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'succeeded' : 'failed';
  let apkInfo: BuildResult['apk'] = null;
  let inspection: ApkInspection | null = null;
  let security: ScanResult | null = null;
  let error: string | null = result.exitCode === 0 ? null : `build command exited with code ${result.exitCode}`;

  if (detection.kind === 'android') {
    const apkPath = await findApk(root, target);
    if (!apkPath) {
      // Gradle can report success while no APK is produced (e.g. no application
      // module). Treat that as a real failure instead of claiming success.
      if (status === 'succeeded') {
        status = 'failed';
        error = 'gradle reported success but no APK was found under app/build/outputs/apk';
        logEvent(input.projectId, 'build_log', 'error', `BUILD FAILED: ${error}`);
      }
    } else {
      const stat = await fs.stat(apkPath);
      const digest = await sha256File(apkPath);
      const relPath = path.relative(root, apkPath).split(path.sep).join('/');
      apkInfo = { path: apkPath, relPath, sizeBytes: stat.size, sha256: digest };
      logEvent(input.projectId, 'build_log', 'info', `APK FOUND: ${relPath} (${stat.size} bytes, sha256 ${digest.slice(0, 16)}...)`);

      logEvent(input.projectId, 'build_log', 'info', 'INSPECTING APK', { phase: 'inspecting' });
      inspection = await inspectApk(apkPath);
      logEvent(input.projectId, 'build_log', 'info', `APK inspection complete (tools: ${inspection.toolsUsed.join(', ') || 'none'})`);

      await query(
        `INSERT INTO artifacts (project_id, build_id, owner_id, kind, rel_path, size_bytes, sha256)
         VALUES ($1, $2, $3, 'apk', $4, $5, $6)`,
        [input.projectId, buildId, input.ownerId, relPath, stat.size, digest],
      );
      logger.info('apk produced', { projectId: input.projectId, relPath, sizeBytes: stat.size });
    }
  }

  if (input.runSecurityScan !== false) {
    logEvent(input.projectId, 'build_log', 'info', 'running secret scan');
    security = await scanProject(input.projectId, apkInfo?.path ?? null);
    await query(
      `INSERT INTO security_scans (project_id, build_id, owner_id, status, findings, files_scanned)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.projectId, buildId, input.ownerId, security.status, JSON.stringify(security.findings), security.filesScanned],
    );
    if (security.status === 'findings') {
      logEvent(input.projectId, 'build_log', 'error', `SECURITY FAILED: ${security.findings.length} potential secret(s) detected`, {
        findings: security.findings.slice(0, 20),
      });
      status = 'failed';
      error = `security scan found ${security.findings.length} potential secret(s)`;
    } else {
      logEvent(input.projectId, 'build_log', 'info', 'secret scan: clean');
    }
  }

  await query(
    `UPDATE builds SET status = $2, log = $3, exit_code = $4, duration_ms = $5, apk_path = $6,
       apk_size_bytes = $7, apk_sha256 = $8, inspection = $9, error = $10, finished_at = now()
     WHERE id = $1`,
    [
      buildId,
      status,
      log.slice(0, 400000),
      result.exitCode,
      result.durationMs,
      apkInfo?.path ?? null,
      apkInfo?.sizeBytes ?? null,
      apkInfo?.sha256 ?? null,
      inspection ? JSON.stringify(inspection) : null,
      error,
    ],
  );

  logEvent(input.projectId, 'build_log', status === 'succeeded' ? 'info' : 'error', `BUILD ${status.toUpperCase()}`, {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    apk: apkInfo?.relPath ?? null,
  });

  return {
    id: buildId,
    kind: detection.kind,
    target,
    status,
    command: detection.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    log,
    apk: apkInfo,
    inspection,
    security,
    error,
  };
}

export async function getBuild(projectId: string, buildId: string): Promise<Record<string, unknown> | null> {
  const res = await query(
    `SELECT * FROM builds WHERE id = $1 AND project_id = $2`,
    [buildId, projectId],
  );
  return res.rows[0] ?? null;
}

export async function listBuilds(projectId: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  const res = await query(
    `SELECT id, kind, target, status, exit_code, duration_ms, apk_path, apk_size_bytes, apk_sha256, error, created_at, finished_at
     FROM builds WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [projectId, limit],
  );
  return res.rows;
}

export async function latestApk(projectId: string): Promise<{ path: string; relPath: string } | null> {
  const res = await query<{ apk_path: string | null }>(
    `SELECT apk_path FROM builds WHERE project_id = $1 AND apk_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  const apkPath = res.rows[0]?.apk_path ?? null;
  if (!apkPath) return null;
  if (!(await exists(apkPath))) return null;
  const root = new WorkspaceService(projectId).root;
  return { path: apkPath, relPath: path.relative(root, apkPath).split(path.sep).join('/') };
}
