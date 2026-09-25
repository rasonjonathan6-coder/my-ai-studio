/**
 * Structured logging with secret redaction.
 *
 * The watchdog handles two kinds of secret: the OpenHands/GitHub credentials it
 * authenticates with, and whatever the recovered studio needs to run. None of
 * them may reach a log, a CI transcript or a commit. Rather than trusting every
 * call site to remember that, redaction happens here, at the single point where
 * a line is emitted.
 *
 * Two independent mechanisms, because either alone has a hole:
 *
 *  - literal values: every secret currently in the environment is replaced
 *    verbatim. This catches a key that has no recognisable prefix.
 *  - shape patterns: token prefixes and long random-looking runs are replaced
 *    even when the value never entered this process, such as a key echoed back
 *    by a remote command.
 *
 * Redaction is applied to the whole serialised line, so a secret nested inside
 * an error object or a response body is caught too.
 */

const ENV_SECRET_NAMES = [
  'OPENHANDS_API_KEY',
  'OPENHANDS_CLOUD_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENROUTER_API_KEY',
  'JWT_SECRET',
  'DATABASE_URL',
  'SESSION_API_KEY',
];

// The studio URL is deliberately absent from the list above. It is public by
// design - it is the value published in url.json - and redacting it would make
// the log unable to say which address was checked, which is the one thing an
// operator needs. MY_AI_STUDIO_DOMAIN is likewise not a secret, and the watchdog
// does not use it at all: url.json is the only source of truth for the address.

/** Keys whose value is a credential regardless of what it looks like. */
const SECRET_KEY_NAMES = /^(session_api_key|api_?key|token|password|passwd|secret|authorization|jwt_secret|database_url)$/i;

const SHAPE_PATTERNS = [
  // OpenRouter, OpenHands, OpenAI-style keys.
  /\bsk-[A-Za-z0-9._-]{8,}\b/g,
  // GitHub personal, OAuth, user, server and refresh tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  // JWTs.
  /\beyJ[A-Za-z0-9._-]{12,}\b/g,
  // A credential in a URL, e.g. postgres://user:pass@host.
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
];

const PLACEHOLDER = '<redacted>';

function literalSecrets() {
  const values = [];
  for (const name of ENV_SECRET_NAMES) {
    const value = process.env[name];
    // Short values are not secrets and redacting them would mangle ordinary
    // output; the names above are all long-lived credentials.
    if (typeof value === 'string' && value.length >= 8) values.push(value);
  }
  return values;
}

/** Replaces secret substrings in a string. Exported for tests. */
export function redact(input) {
  let text = typeof input === 'string' ? input : String(input);
  for (const secret of literalSecrets()) {
    text = text.split(secret).join(PLACEHOLDER);
  }
  for (const pattern of SHAPE_PATTERNS) {
    text = text.replace(pattern, (match, prefix) =>
      // Keep the scheme for URL credentials so the log still says what it was.
      prefix && match.includes('@') ? `${prefix}:${PLACEHOLDER}@` : PLACEHOLDER,
    );
  }
  return text;
}

/**
 * Deep-copies a value, replacing any entry whose key names a credential. This is
 * what stops a whole API response being logged safely-by-accident.
 */
export function redactValue(value, depth = 0) {
  if (depth > 8) return '<depth-limit>';
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redact(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY_NAMES.test(key) ? PLACEHOLDER : redactValue(item, depth + 1);
  }
  return out;
}

function emit(level, message, fields = {}) {
  const line = {
    level,
    time: new Date().toISOString(),
    scope: 'watchdog',
    msg: message,
    ...redactValue(fields),
  };
  const serialised = redact(JSON.stringify(line));
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${serialised}\n`);
}

export const log = {
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};
