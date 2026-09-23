import { createServer } from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config/index.ts';
import { logger } from './lib/logger.ts';
import { attachUser } from './middleware/auth.ts';
import { errorHandler, notFound } from './middleware/validate.ts';
import { rateLimit } from './middleware/rateLimit.ts';
import authRoutes from './routes/auth.ts';
import projectRoutes from './routes/projects.ts';
import systemRoutes from './routes/system.ts';
import aiRoutes from './routes/ai.ts';
import { attachWebSocket } from './ws/server.ts';
import { closePool, checkDatabase } from './db/pool.ts';
import { runMigrations } from './db/migrate.ts';
import { jobQueue } from './services/jobQueue.ts';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: false, // the API serves no HTML; the SPA sets its own policy
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) return callback(null, true);
      logger.warn('cors origin rejected', { origin });
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }));

  app.use(express.json({ limit: config.maxRequestBody }));
  app.use(express.urlencoded({ extended: false, limit: config.maxRequestBody }));
  app.use(cookieParser());
  app.use(rateLimit({ keyPrefix: 'api' }));
  app.use(attachUser);
  app.use((req, _res, next) => {
    logger.debug('request', { method: req.method, path: req.path, ip: req.ip });
    next();
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/ai', aiRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api', systemRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export async function startServer(): Promise<{ close: () => Promise<void> }> {
  await fs.mkdir(config.workspaceRoot, { recursive: true });
  await fs.mkdir(config.storageRoot, { recursive: true });

  // Apply migrations at boot when a database is configured, so a fresh
  // deployment comes up with a real schema instead of failing on first query.
  if (config.databaseUrl) {
    try {
      const result = await runMigrations();
      logger.info('migrations complete', { applied: result.applied.length, skipped: result.skipped.length });
    } catch (err) {
      logger.error('migration failed at boot', { error: err instanceof Error ? err.message : String(err) });
    }
  } else {
    logger.warn('DATABASE_URL is not configured: database-backed endpoints will return 503');
  }

  const app = await createApp();
  const server = createServer(app);
  const wss = attachWebSocket(server);

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));

  const db = await checkDatabase();
  logger.info('my-ai-studio backend listening', {
    url: `http://${config.host}:${config.port}`,
    env: config.env,
    database: db.configured ? (db.connected ? 'connected' : 'unreachable') : 'not_configured',
    openrouter: config.openRouterApiKey ? 'configured' : 'not_configured',
    sandbox: config.sandbox.enabled ? 'docker' : 'host',
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });

    jobQueue.cancelAll();
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    wss.close();

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    logger.info('shutdown complete', { signal });
  };

  const onSignal = (signal: string) => {
    void shutdown(signal).then(() => process.exit(0));
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  // A hard deadline prevents a hung connection from blocking restarts forever.
  const forceExit = setTimeout(() => {
    if (shuttingDown) {
      logger.warn('forcing exit after shutdown deadline');
      process.exit(1);
    }
  }, 15000);
  forceExit.unref();

  return { close: () => shutdown('manual') };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'server.ts')) || path.resolve(process.argv[1]).endsWith(path.join('dist', 'server.js'));
if (isMain) {
  startServer().catch((err: unknown) => {
    logger.error('failed to start server', { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
