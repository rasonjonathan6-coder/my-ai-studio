import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.ts';
import { verifySession } from '../services/auth.ts';
import { findUserById, type PublicUser, toPublicUser } from '../services/auth.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[config.sessionCookieName];
  if (typeof cookie === 'string' && cookie.length > 0) return cookie;
  return null;
}

/** Soft auth: attaches req.user when a valid session exists, never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) return next();
  const decoded = verifySession(token);
  if (!decoded) return next();
  try {
    const user = await findUserById(decoded.userId);
    if (user) req.user = toPublicUser(user);
  } catch {
    // database unavailable: treat as anonymous rather than crashing the request
  }
  next();
}

/** Hard auth: rejects unauthenticated requests. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  next();
}

/**
 * Admin auth. Guards the endpoints that manage server-wide credentials, which
 * are not project-scoped and therefore must not be reachable by an ordinary
 * account. Must be mounted after requireAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  if (!req.user.isAdmin) {
    // Deliberately the same shape as an auth failure: an ordinary user should
    // not learn that an admin-only surface exists.
    res.status(403).json({ error: 'administrator privileges required', code: 'admin_required' });
    return;
  }
  next();
}
