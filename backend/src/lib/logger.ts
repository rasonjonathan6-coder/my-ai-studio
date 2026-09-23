import { config } from '../config/index.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SECRET_PATTERNS: RegExp[] = [
  /sk-or-[A-Za-z0-9_-]{8,}/g,
  /(OPENROUTER_API_KEY\s*[=:]\s*)\S+/gi,
  /(DATABASE_URL\s*[=:]\s*)\S+/gi,
  /(JWT_SECRET\s*[=:]\s*)\S+/gi,
  /(password\s*[=:]\s*)\S+/gi,
  /(api[_-]?key\s*[=:]\s*)\S+/gi,
  /(authorization:\s*bearer\s+)\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Replace known secret shapes with a mask. Never log raw credentials. */
export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix?: string) =>
      prefix ? `${prefix}[REDACTED]` : '[REDACTED]',
    );
  }
  if (config.openRouterApiKey) {
    out = out.split(config.openRouterApiKey).join('[REDACTED]');
  }
  const dbPassword = extractDbPassword(config.databaseUrl);
  if (dbPassword) out = out.split(dbPassword).join('[REDACTED]');
  return out;
}

function extractDbPassword(url: string): string {
  if (!url) return '';
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return '';
  }
}

export interface LogRecord {
  level: Level;
  time: string;
  msg: string;
  [key: string]: unknown;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < LEVELS[config.logLevel as Level]) return;
  const record: LogRecord = {
    level,
    time: new Date().toISOString(),
    msg: redact(msg),
    ...redactFields(fields),
  };
  const line = JSON.stringify(record);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (/password|secret|token|api_?key|authorization/i.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      out[key] = redact(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
