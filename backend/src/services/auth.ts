import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.ts';
import { query } from '../db/pool.ts';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export const BCRYPT_ROUNDS = 12;

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
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

export async function createUser(email: string, password: string, displayName?: string): Promise<UserRow> {
  const hash = await hashPassword(password);
  const res = await query<UserRow>(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, password_hash, display_name, created_at`,
    [email.toLowerCase(), hash, displayName ?? null],
  );
  return res.rows[0];
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const res = await query<UserRow>(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1',
    [email.toLowerCase()],
  );
  return res.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const res = await query<UserRow>(
    'SELECT id, email, password_hash, display_name, created_at FROM users WHERE id = $1',
    [id],
  );
  return res.rows[0] ?? null;
}
