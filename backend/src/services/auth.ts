import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.ts';
import { query, withTransaction } from '../db/pool.ts';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  is_admin: boolean;
  created_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  createdAt: string;
}

export const BCRYPT_ROUNDS = 12;

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === true,
    createdAt: row.created_at.toISOString(),
  };
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId, iss: 'my-ai-studio' }, config.jwtSecret, {
    expiresIn: config.jwtTtlSeconds,
    algorithm: 'HS256',
  });
}

export function verifySession(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as { sub?: string };
    if (!payload.sub) return null;
    return { userId: payload.sub };
  } catch {
    return null;
  }
}

/**
 * Creates a user. The first account to register becomes an admin so a fresh
 * deployment has somebody who can configure the GitHub credential; without that
 * the admin API would be unreachable and the feature would be dead on arrival.
 * The check and the insert share one transaction so two concurrent registrations
 * cannot both claim the first-user slot.
 */
export async function createUser(email: string, password: string, displayName?: string): Promise<UserRow> {
  const hash = await hashPassword(password);
  return withTransaction(async (client) => {
    const count = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
    const isFirst = count.rows[0]?.n === '0';
    const res = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name, is_admin)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, password_hash, display_name, is_admin, created_at`,
      [email.toLowerCase(), hash, displayName ?? null, isFirst],
    );
    return res.rows[0];
  });
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const res = await query<UserRow>(
    'SELECT id, email, password_hash, display_name, is_admin, created_at FROM users WHERE email = $1',
    [email.toLowerCase()],
  );
  return res.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const res = await query<UserRow>(
    'SELECT id, email, password_hash, display_name, is_admin, created_at FROM users WHERE id = $1',
    [id],
  );
  return res.rows[0] ?? null;
}

/** Whether any admin exists, so a deployment can report that it cannot be configured. */
export async function hasAdmin(): Promise<boolean> {
  const res = await query<{ n: string }>('SELECT count(*)::text AS n FROM users WHERE is_admin');
  return (res.rows[0]?.n ?? '0') !== '0';
}

/**
 * Promotes an existing account to admin by email.
 *
 * The first-user bootstrap only helps a brand new deployment. An installation
 * that already has users would otherwise have no way to reach the admin-only
 * credential API, so MY_AI_STUDIO_ADMIN_EMAIL names the operator declaratively
 * and this runs at startup. Returns the promoted email, or null when there is
 * nothing to do.
 */
export async function promoteAdminByEmail(email: string): Promise<string | null> {
  const res = await query<{ email: string }>(
    'UPDATE users SET is_admin = true WHERE email = $1 AND NOT is_admin RETURNING email',
    [email.toLowerCase()],
  );
  if (res.rowCount && res.rowCount > 0) return res.rows[0].email;

  // Already an admin, or no such account. Distinguish so startup can warn about
  // a typo rather than silently leaving the deployment unconfigurable.
  const existing = await findUserByEmail(email);
  if (!existing) {
    throw new Error(`MY_AI_STUDIO_ADMIN_EMAIL names ${email}, but no such account exists`);
  }
  return null;
}
