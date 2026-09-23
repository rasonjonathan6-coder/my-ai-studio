/**
 * Workspace path safety. Every file operation goes through resolveInsideWorkspace
 * so a malicious project/file name can never escape the per-project directory.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config/index.ts';

export class PathSecurityError extends Error {
  public override readonly name = 'PathSecurityError';
}

const FORBIDDEN_SEGMENTS = new Set(['..', '.', '']);

/** Validates a project id / slug before it is used as a directory name. */
export function assertSafeSegment(segment: string, label = 'segment'): string {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new PathSecurityError(`invalid ${label}: empty`);
  }
  if (segment.length > 128) {
    throw new PathSecurityError(`invalid ${label}: too long`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)) {
    throw new PathSecurityError(`invalid ${label}: illegal characters`);
  }
  if (FORBIDDEN_SEGMENTS.has(segment) || segment.includes('..')) {
    throw new PathSecurityError(`invalid ${label}: traversal detected`);
  }
  return segment;
}

export function projectDir(projectId: string): string {
  const safe = assertSafeSegment(projectId, 'projectId');
  return path.join(config.workspaceRoot, safe);
}

export function projectStorageDir(projectId: string): string {
  const safe = assertSafeSegment(projectId, 'projectId');
  return path.join(config.storageRoot, safe);
}

/**
 * Normalises a caller-supplied relative path and resolves it inside the
 * project directory. Rejects absolute paths, traversal, NUL bytes and
 * symlinked escapes.
 */
export function resolveInside(root: string, relativePath: string): string {
  if (typeof relativePath !== 'string') throw new PathSecurityError('invalid path: not a string');
  if (relativePath.includes('\0')) throw new PathSecurityError('invalid path: NUL byte');
  if (path.isAbsolute(relativePath)) throw new PathSecurityError('invalid path: absolute paths rejected');
  if (/^[A-Za-z]:/.test(relativePath)) throw new PathSecurityError('invalid path: drive letters rejected');

  const normalised = path.normalize(relativePath.replace(/\\/g, '/'));
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, normalised);

  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new PathSecurityError('path traversal detected');
  }
  return target;
}

export async function resolveInsideExisting(root: string, relativePath: string): Promise<string> {
  const target = resolveInside(root, relativePath);
  const rootReal = await fs.realpath(path.resolve(root));
  const targetReal = await fs.realpath(target);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new PathSecurityError('symlink escape detected');
  }
  return targetReal;
}

export function assertSafeCommandName(name: string): string {
  if (!/^[A-Za-z0-9._+-]+$/.test(name) || name.includes('..')) {
    throw new PathSecurityError(`invalid executable name: ${name}`);
  }
  return name;
}
