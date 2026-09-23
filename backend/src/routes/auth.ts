import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { config } from '../config/index.ts';
import { asyncHandler, HttpError, validate } from '../middleware/validate.ts';
import { requireAuth } from '../middleware/auth.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import { createUser, findUserByEmail, signSession, toPublicUser, verifyPassword } from '../services/auth.ts';
import { audit } from '../services/projects.ts';
import { isDatabaseConfigured } from '../db/pool.ts';
import { logger } from '../lib/logger.ts';

const router = Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyPrefix: 'auth' });

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10, 'password must be at least 10 characters').max(200),
  displayName: z.string().max(80).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

function setSessionCookie(res: Response, token: string): void {
  res.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: config.sessionCookieSameSite,
    secure: config.sessionCookieSecure,
    maxAge: config.jwtTtlSeconds * 1000,
    path: '/',
  });
}

router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  if (!isDatabaseConfigured()) throw new HttpError(503, 'DATABASE_URL is not configured on the server', 'database_not_configured');
  const body = validate(registerSchema, req.body);
  const existing = await findUserByEmail(body.email);
  if (existing) {
    await audit({ action: 'auth.register', outcome: 'duplicate', ip: req.ip ?? null, detail: { email: body.email } });
    throw new HttpError(409, 'an account with this email already exists', 'email_taken');
  }
  const user = await createUser(body.email, body.password, body.displayName);
  const token = signSession(user.id);
  setSessionCookie(res, token);
  await audit({ userId: user.id, action: 'auth.register', ip: req.ip ?? null });
  logger.info('user registered', { userId: user.id });
  res.status(201).json({ user: toPublicUser(user), token });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  if (!isDatabaseConfigured()) throw new HttpError(503, 'DATABASE_URL is not configured on the server', 'database_not_configured');
  const body = validate(loginSchema, req.body);
  const user = await findUserByEmail(body.email);
  const genericFailure = new HttpError(401, 'invalid email or password', 'invalid_credentials');
  if (!user) {
    await audit({ action: 'auth.login', outcome: 'no_such_user', ip: req.ip ?? null });
    throw genericFailure;
  }
  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) {
    await audit({ userId: user.id, action: 'auth.login', outcome: 'bad_password', ip: req.ip ?? null });
    throw genericFailure;
  }
  const token = signSession(user.id);
  setSessionCookie(res, token);
  await audit({ userId: user.id, action: 'auth.login', ip: req.ip ?? null });
  res.json({ user: toPublicUser(user), token });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  res.clearCookie(config.sessionCookieName, { path: '/' });
  if (req.user) await audit({ userId: req.user.id, action: 'auth.logout', ip: req.ip ?? null });
  res.json({ ok: true });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  res.json({ user: req.user });
}));

export default router;
