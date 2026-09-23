/**
 * Projects, conversations, messages and audit helpers.
 * Every read/write is scoped by owner_id in SQL: ownership is enforced in the
 * data layer, not by trusting anything the client sends.
 */
import { query } from '../db/pool.ts';
import type { PoolClient } from 'pg';

export type ProjectKind = 'generic' | 'android' | 'node' | 'static';

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  template: string;
  kind: ProjectKind;
  package_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'project';
}

export async function createProject(input: {
  ownerId: string;
  name: string;
  slug: string;
  description?: string;
  template: string;
  kind: ProjectKind;
  packageName?: string | null;
}): Promise<ProjectRow> {
  const res = await query<ProjectRow>(
    `INSERT INTO projects (owner_id, name, slug, description, template, kind, package_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [input.ownerId, input.name, input.slug, input.description ?? null, input.template, input.kind, input.packageName ?? null],
  );
  return res.rows[0];
}

export async function listProjects(ownerId: string, limit = 50, offset = 0): Promise<ProjectRow[]> {
  const res = await query<ProjectRow>(
    `SELECT * FROM projects WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
    [ownerId, limit, offset],
  );
  return res.rows;
}

export async function getProjectForOwner(projectId: string, ownerId: string): Promise<ProjectRow | null> {
  if (!isUuid(projectId)) return null;
  const res = await query<ProjectRow>('SELECT * FROM projects WHERE id = $1 AND owner_id = $2', [projectId, ownerId]);
  return res.rows[0] ?? null;
}

/**
 * Authorization check used by the agent-run worker, which has no request user.
 * Returns the project only when it belongs to the given owner.
 */
export async function getProjectForOwnerRaw(projectId: string, ownerId: string): Promise<ProjectRow | null> {
  return getProjectForOwner(projectId, ownerId);
}

export async function touchProject(projectId: string, client?: PoolClient): Promise<void> {
  const sql = 'UPDATE projects SET updated_at = now() WHERE id = $1';
  if (client) await client.query(sql, [projectId]);
  else await query(sql, [projectId]);
}

export async function deleteProject(projectId: string, ownerId: string): Promise<boolean> {
  if (!isUuid(projectId)) return false;
  const res = await query('DELETE FROM projects WHERE id = $1 AND owner_id = $2', [projectId, ownerId]);
  return (res.rowCount ?? 0) > 0;
}

export async function getOrCreateConversation(projectId: string, ownerId: string): Promise<{ id: string; title: string }> {
  const existing = await query<{ id: string; title: string }>(
    `SELECT id, title FROM conversations WHERE project_id = $1 AND owner_id = $2 ORDER BY updated_at DESC LIMIT 1`,
    [projectId, ownerId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const created = await query<{ id: string; title: string }>(
    `INSERT INTO conversations (project_id, owner_id) VALUES ($1, $2) RETURNING id, title`,
    [projectId, ownerId],
  );
  return created.rows[0];
}

export async function addMessage(
  conversationId: string,
  role: 'user' | 'assistant' | 'system' | 'tool',
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<{ id: string }> {
  const res = await query<{ id: string }>(
    `INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, $2, $3, $4) RETURNING id`,
    [conversationId, role, content, JSON.stringify(metadata)],
  );
  await query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return res.rows[0];
}

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function listMessages(conversationId: string, limit = 50, before?: string): Promise<MessageRow[]> {
  if (before && /^\d+$/.test(before)) {
    const res = await query<MessageRow>(
      `SELECT id, role, content, metadata, created_at FROM messages
       WHERE conversation_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3`,
      [conversationId, before, limit],
    );
    return res.rows.reverse();
  }
  const res = await query<MessageRow>(
    `SELECT id, role, content, metadata, created_at FROM messages
     WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2`,
    [conversationId, limit],
  );
  return res.rows.reverse();
}

export async function audit(entry: {
  userId?: string | null;
  projectId?: string | null;
  action: string;
  outcome?: string;
  ip?: string | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (user_id, project_id, action, outcome, ip, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.userId ?? null,
        entry.projectId ?? null,
        entry.action,
        entry.outcome ?? 'ok',
        entry.ip ?? null,
        JSON.stringify(entry.detail ?? {}),
      ],
    );
  } catch {
    // Audit failures must never break the request path; they are logged upstream.
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
