import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { logger } from '../lib/logger.ts';

export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export function validate<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'validation_error');
  }
  return parsed.data;
}

/** Central error handler. Never leaks stack traces or secrets to clients. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', detail: err.issues.map((i) => i.message) });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error('unhandled request error', { error: message });
  const status = /DATABASE_URL is not configured/i.test(message) ? 503 : 500;
  res.status(status).json({
    error: status === 503 ? 'database_not_configured' : 'internal_error',
    message: status === 503 ? message : 'internal server error',
  });
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found' });
}
