/**
 * Export service. Produces a real ZIP of the project workspace using the
 * system zip binary with explicit exclusions, then verifies the archive by
 * re-reading its entry list and checking that no secret-bearing paths slipped in.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WorkspaceService } from './workspace.ts';
import { sha256File, formatBytes } from '../lib/hash.ts';
import { query } from '../db/pool.ts';

const EXCLUDED_PATTERNS = [
  '.env', '.env.*', '*.env',
  'node_modules/*', '*/.git/*', '.git/*',
  'build/*', '*/build/*', 'dist/*', '*/dist/*',
  '.gradle/*', '*/.gradle/*',
  '.cache/*', '*/.cache/*',
  '*.keystore', '*.jks', '*.p12', '*.pem', '*.key',
  '*secrets*', '*credentials*', '*.apk', '*.aab',
  'coverage/*', '*/.next/*', '*/.venv/*', '*.log',
];

export interface ZipResult {
  ok: boolean;
  zipPath: string | null;
  relPath: string | null;
  sizeBytes: number;
  sha256: string | null;
  entryCount: number;
  excludedEntries: string[];
  error: string | null;
}

function runZip(cwd: string, args: string[], timeoutMs = 300000): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn('zip', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

function runUnzipList(zipPath: string): Promise<{ ok: boolean; entries: string[]; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('unzip', ['-Z1', zipPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => resolve({ ok: false, entries: [], stderr: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, entries: stdout.split('\n').map((l) => l.trim()).filter(Boolean), stderr }));
  });
}

export async function exportZip(input: { projectId: string; ownerId: string }): Promise<ZipResult> {
  const ws = new WorkspaceService(input.projectId);
  await ws.ensure();
  const storage = await ws.ensureStorage();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = path.join(storage, `project-${stamp}.zip`);

  const args = ['-r', '-q', zipPath, '.', ...EXCLUDED_PATTERNS.flatMap((p) => ['-x', p])];
  const result = await runZip(ws.root, args);

  if (!result.ok && !(await fs.stat(zipPath).catch(() => null))) {
    return {
      ok: false, zipPath: null, relPath: null, sizeBytes: 0, sha256: null, entryCount: 0,
      excludedEntries: [], error: `zip failed: ${result.stderr.trim().slice(0, 400) || `exit code ${result.code}`}`,
    };
  }

  const listing = await runUnzipList(zipPath);
  const stat = await fs.stat(zipPath);
  const digest = await sha256File(zipPath);

  // Verify exclusions held: these paths must not be inside the archive.
  const leaks = listing.entries.filter((entry) => {
    const base = path.basename(entry);
    return base === '.env' || /^\.env\./.test(base) || /\.(keystore|jks|p12|pem|key)$/i.test(base) ||
      /(^|\/)(node_modules|\.git)\//.test(entry) || /secrets?\.|credentials?\./i.test(base);
  });

  const storedRel = `artifacts/${path.basename(zipPath)}`;

  if (leaks.length === 0) {
    await query(
      `INSERT INTO artifacts (project_id, owner_id, kind, rel_path, size_bytes, sha256) VALUES ($1, $2, 'zip', $3, $4, $5)`,
      [input.projectId, input.ownerId, storedRel, stat.size, digest],
    );
  }

  return {
    ok: leaks.length === 0,
    zipPath,
    relPath: storedRel,
    sizeBytes: stat.size,
    sha256: digest,
    entryCount: listing.entries.length,
    excludedEntries: leaks,
    error: leaks.length > 0
      ? `export aborted: ${leaks.length} excluded path(s) present in archive (${leaks.slice(0, 5).join(', ')})`
      : result.ok ? null : `zip exited with code ${result.code}`,
  };
}

export function describeSize(bytes: number): string {
  return formatBytes(bytes);
}
