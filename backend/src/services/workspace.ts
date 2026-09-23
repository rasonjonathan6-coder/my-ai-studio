/**
 * Real filesystem operations scoped to a project workspace directory.
 * Every path goes through resolveInside so traversal and symlink escapes fail.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.ts';
import {
  PathSecurityError,
  projectDir,
  resolveInside,
  resolveInsideExisting,
} from '../lib/paths.ts';

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export class WorkspaceService {
  public readonly projectId: string;
  public readonly root: string;

  constructor(projectId: string) {
    this.projectId = projectId;
    this.root = projectDir(projectId);
  }

  async ensure(): Promise<string> {
    await fs.mkdir(this.root, { recursive: true });
    return this.root;
  }

  /** recursively lists entries, skipping heavy/irrelevant directories */
  async list(relDir = '.', depth = 3, currentDepth = 0): Promise<FileEntry[]> {
    const target = await resolveInsideExisting(this.root, relDir).catch(async (err: unknown) => {
      if (err instanceof PathSecurityError) throw err;
      await this.ensure();
      return resolveInside(this.root, relDir);
    });
    let dirents;
    try {
      dirents = await fs.readdir(target, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      if (IGNORED_DIRS.has(dirent.name)) continue;
      const abs = path.join(target, dirent.name);
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      let stat;
      try {
        stat = await fs.lstat(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      entries.push({
        name: dirent.name,
        path: rel,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? stat.size : 0,
        modifiedAt: stat.mtime.toISOString(),
      });
      if (stat.isDirectory() && currentDepth + 1 < depth) {
        const children = await this.list(rel, depth, currentDepth + 1);
        entries.push(...children);
      }
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(relPath: string): Promise<{ path: string; content: string; size: number }> {
    const abs = await resolveInsideExisting(this.root, relPath);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) throw new Error(`${relPath} is not a file`);
    if (stat.size > config.maxFileBytes) {
      throw new Error(`file exceeds MAX_FILE_BYTES (${stat.size} > ${config.maxFileBytes})`);
    }
    const content = await fs.readFile(abs, 'utf8');
    return { path: relPath, content, size: stat.size };
  }

  async write(relPath: string, content: string): Promise<{ path: string; size: number }> {
    if (Buffer.byteLength(content, 'utf8') > config.maxFileBytes) {
      throw new Error(`content exceeds MAX_FILE_BYTES (${config.maxFileBytes})`);
    }
    const abs = resolveInside(this.root, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const stat = await fs.stat(abs);
    return { path: relPath, size: stat.size };
  }

  async create(relPath: string, content = ''): Promise<{ path: string; created: boolean }> {
    const abs = resolveInside(this.root, relPath);
    try {
      await fs.access(abs);
      return { path: relPath, created: false };
    } catch {
      await this.write(relPath, content);
      return { path: relPath, created: true };
    }
  }

  async remove(relPath: string): Promise<{ path: string; removed: boolean }> {
    const abs = resolveInside(this.root, relPath);
    if (path.resolve(abs) === path.resolve(this.root)) {
      throw new PathSecurityError('refusing to delete the project root');
    }
    try {
      await fs.rm(abs, { recursive: true, force: false });
      return { path: relPath, removed: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { path: relPath, removed: false };
      throw err;
    }
  }

  async search(query: string, opts: { maxResults?: number; caseSensitive?: boolean; regex?: boolean } = {}): Promise<
    Array<{ path: string; line: number; text: string }>
  > {
    const maxResults = opts.maxResults ?? 200;
    const files = (await this.list('.', 12)).filter((e) => e.type === 'file' && e.size <= config.maxFileBytes);
    const results: Array<{ path: string; line: number; text: string }> = [];
    let matcher: (line: string) => boolean;
    if (opts.regex) {
      let re: RegExp;
      try {
        re = new RegExp(query, opts.caseSensitive ? '' : 'i');
      } catch {
        throw new Error('invalid regular expression');
      }
      matcher = (line) => re.test(line);
    } else {
      const needle = opts.caseSensitive ? query : query.toLowerCase();
      matcher = (line) => (opts.caseSensitive ? line : line.toLowerCase()).includes(needle);
    }

    for (const file of files) {
      if (results.length >= maxResults) break;
      if (BINARY_EXT.has(path.extname(file.name).toLowerCase())) continue;
      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, file.path), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (matcher(lines[i])) {
          results.push({ path: file.path, line: i + 1, text: lines[i].slice(0, 400) });
          if (results.length >= maxResults) break;
        }
      }
    }
    return results;
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(resolveInside(this.root, relPath));
      return true;
    } catch {
      return false;
    }
  }

  async totalSize(): Promise<number> {
    const entries = await this.list('.', 20);
    return entries.filter((e) => e.type === 'file').reduce((sum, e) => sum + e.size, 0);
  }

  /** Writes a project file, refusing paths that would escape the workspace. */
  safeResolve(relPath: string): string {
    return resolveInside(this.root, relPath);
  }

  public get projectStorage(): string {
    return path.join(config.storageRoot, this.projectId);
  }

  async ensureStorage(): Promise<string> {
    await fs.mkdir(this.projectStorage, { recursive: true });
    return this.projectStorage;
  }
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.gradle',
  'build',
  'dist',
  '.cache',
  '.idea',
  '__pycache__',
  '.venv',
  'venv',
]);

const BINARY_EXT = new Set([
  '.apk', '.aab', '.jar', '.class', '.dex', '.so', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.ico', '.pdf', '.zip', '.gz', '.tar', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4',
]);
