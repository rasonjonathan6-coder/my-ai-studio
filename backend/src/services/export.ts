/**
 * Export service. Produces a real ZIP of the project workspace.
 *
 * The archive is assembled in-process by the ZIP writer rather than by shelling
 * out to a system `zip` binary: the binary is absent from slim images, and its
 * failure produced an opaque 500. Files are walked here so exclusions are
 * applied to the same data that is archived, and the result is then re-read with
 * the production ZIP reader to confirm no secret-bearing path slipped in.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceService } from './workspace.ts';
import { sha256Hex, formatBytes } from '../lib/hash.ts';
import { query } from '../db/pool.ts';
import { writeZip, type ZipSourceEntry } from '../lib/zipWriter.ts';
import { readZipEntries } from '../lib/apkZip.ts';

/**
 * Paths never written to the archive. Matched as whole path segments so that
 * `mynode_modules` is kept while `node_modules` is dropped, and as extensions so
 * that a key file nested anywhere is excluded.
 */
const EXCLUDED_SEGMENTS = new Set([
  'node_modules', '.git', 'build', 'dist', '.gradle', '.cache', '.next', '.venv',
  'coverage', '__pycache__', '.idea', '.kotlin',
]);
const EXCLUDED_EXTENSIONS = new Set(['.keystore', '.jks', '.p12', '.pem', '.key', '.apk', '.aab', '.log']);
const EXCLUDED_NAMES = new Set(['.env', '.envrc', '.DS_Store']);
// `secrets.txt` and `credentials.json` are excluded on their stem, whatever the
// extension, so a renamed dump is still withheld.
const EXCLUDED_STEMS = /^(secrets?|credentials?)$/i;

/** Whether a workspace-relative path may appear in the export. */
export function isExportable(relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1];
  if (segments.some((s) => EXCLUDED_SEGMENTS.has(s))) return false;
  if (EXCLUDED_NAMES.has(base)) return false;
  if (/^\.env(\.|$)/.test(base)) return false;
  if (EXCLUDED_EXTENSIONS.has(path.extname(base).toLowerCase())) return false;
  return !EXCLUDED_STEMS.test(path.parse(base).name);
}

/** Single-file guard: an oversized workspace must not exhaust memory. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

/** Walks the workspace and returns the entries the archive may contain. */
async function collectEntries(root: string): Promise<{ entries: ZipSourceEntry[]; skipped: number }> {
  const entries: ZipSourceEntry[] = [];
  let skipped = 0;
  let total = 0;

  const walk = async (dir: string, prefix: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (!isExportable(rel)) continue;
      const abs = path.join(dir, item.name);
      if (item.isSymbolicLink()) {
        // Symlinks could point outside the workspace; never follow them.
        skipped += 1;
        continue;
      }
      if (item.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!item.isFile()) continue;
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) {
        skipped += 1;
        continue;
      }
      total += stat.size;
      entries.push({ name: rel, content: await fs.readFile(abs), mtime: stat.mtime });
    }
  };

  await walk(root, '');
  return { entries, skipped };
}

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

/** Re-runs the exclusion rules over the finished archive as a cross-check. */
function findLeaks(entryNames: string[]): string[] {
  return entryNames.filter((name) => !isExportable(name));
}

export async function exportZip(input: { projectId: string; ownerId: string }): Promise<ZipResult> {
  const ws = new WorkspaceService(input.projectId);
  await ws.ensure();
  const storage = await ws.ensureStorage();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const zipPath = path.join(storage, `project-${stamp}.zip`);

  let archive: Buffer;
  let entryCount: number;
  try {
    const { entries, skipped } = await collectEntries(ws.root);
    const written = writeZip(entries);
    archive = written.buffer;
    entryCount = written.entryCount;
    // A workspace with nothing exportable is an empty archive; the leak check
    // below still runs and reports honestly.
    void skipped;
  } catch (err) {
    return {
      ok: false, zipPath: null, relPath: null, sizeBytes: 0, sha256: null, entryCount: 0,
      excludedEntries: [], error: `zip failed: ${(err as Error).message.slice(0, 400)}`,
    };
  }

  await fs.writeFile(zipPath, archive);

  // Read the archive back with the production reader: this catches a writer bug
  // that would have produced an unopenable download.
  const readBack = readZipEntries(archive);
  if (!readBack.ok) {
    return {
      ok: false, zipPath: null, relPath: null, sizeBytes: 0, sha256: null, entryCount: 0,
      excludedEntries: [], error: `zip failed verification: ${readBack.error ?? 'unreadable archive'}`,
    };
  }

  const digest = sha256Hex(archive);
  const leaks = findLeaks(readBack.entries.map((e) => e.name));
  const storedRel = `artifacts/${path.basename(zipPath)}`;

  if (leaks.length === 0) {
    await query(
      `INSERT INTO artifacts (project_id, owner_id, kind, rel_path, size_bytes, sha256) VALUES ($1, $2, 'zip', $3, $4, $5)`,
      [input.projectId, input.ownerId, storedRel, archive.length, digest],
    );
  }

  return {
    ok: leaks.length === 0,
    zipPath,
    relPath: storedRel,
    sizeBytes: archive.length,
    sha256: digest,
    entryCount,
    excludedEntries: leaks,
    error: leaks.length > 0
      ? `export aborted: ${leaks.length} excluded path(s) present in archive (${leaks.slice(0, 5).join(', ')})`
      : null,
  };
}

export function describeSize(bytes: number): string {
  return formatBytes(bytes);
}
