/**
 * Fixed-window rate limiter. State is per-process; behind multiple replicas this
 * must be moved to a shared store, which is documented rather than pretended.
 */
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.ts';

interface Bucket {
  count: number;
  resetAt: number;
}

export function rateLimit(options: { windowMs?: number; max?: number; keyPrefix?: string } = {}) {
  const windowMs = options.windowMs ?? config.rateLimitWindowMs;
  const max = options.max ?? config.rateLimitMax;
  const prefix = options.keyPrefix ?? 'global';
  const buckets = new Map<string, Bucket>();

  // Periodic sweep keeps the map from growing without bound.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs);
  sweeper.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = req.user?.id ?? req.ip ?? 'unknown';
    const key = `${prefix}:${identity}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: 'rate limit exceeded', retryAfterMs: bucket.resetAt - now });
      return;
    }
    next();
  };
}
