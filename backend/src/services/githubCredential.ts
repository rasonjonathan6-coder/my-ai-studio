import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.ts';
import { isDatabaseConfigured, query } from '../db/pool.ts';
import { logger, registerSecret, forgetSecret, redact } from '../lib/logger.ts';

/**
 * My AI Studio's own GitHub credential.
 *
 * This exists because the hosting runtime injects its own GITHUB_TOKEN into
 * every process, and in Node a process environment variable always overrides
 * --env-file. A deployment therefore cannot use that name. This store keeps the
 * credential under the app's control, in the app's own database, encrypted at
 * rest, so it neither depends on nor is shadowed by the host environment and it
 * survives a restart.
 *
 * The value never leaves this module except as a token handed to an outgoing
 * GitHub request. Callers outside get a fingerprint, never the secret.
 */

export type CredentialSource = 'database' | 'env' | 'app' | 'none';

interface StoredRow {
  ciphertext: string;
  iv: string;
  auth_tag: string;
  fingerprint: string;
  token_kind: string;
  repo: string | null;
  updated_at: Date;
}

export interface StoredCredentialInfo {
  source: CredentialSource;
  fingerprint: string | null;
  tokenKind: string | null;
  repo: string | null;
  updatedAt: string | null;
  /** True when a credential is available from any source. */
  configured: boolean;
}

// In-memory copy of the database-stored credential, so a request never waits on
// the database. Refreshed on startup and whenever the admin API changes it. The
// environment fallback is deliberately NOT cached: it is derived from config on
// each read, so a change to config is observed immediately.
let cachedToken: string | null = null;
let cachedDbInfo: StoredCredentialInfo | null = null;

/**
 * Derives the at-rest encryption key. MY_AI_STUDIO_CREDENTIAL_KEY is preferred
 * so the credential survives a JWT_SECRET rotation; the salt means the derived
 * database key is not the same bytes as any other key in use, so a leak of one
 * does not compromise the other. Changing this key invalidates stored
 * credentials by design; the admin API is the recovery path.
 */
function encryptionKey(): Buffer {
  return createHash('sha256').update(`my-ai-studio:github-credential:v1:${config.credentialKey}`).digest();
}

function encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(row: Pick<StoredRow, 'ciphertext' | 'iv' | 'auth_tag'>): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    // A wrong key (JWT_SECRET changed) is indistinguishable from tampering here;
    // both mean the credential must be re-entered, so it is treated as absent.
    logger.warn('stored GitHub credential could not be decrypted; it must be re-entered');
    return null;
  }
}

/**
 * A short digest used to recognise a credential without revealing it. Confirmed
 * against a candidate by hashing the candidate, so the UI can say "matches" or
 * "differs" and never needs the original.
 */
export function fingerprintOf(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Recognises the shape of a credential. Never returns any of its characters. */
export function tokenKindOf(token: string): string {
  if (token.startsWith('github_pat_')) return 'fine-grained-pat';
  if (/^ghp_/.test(token)) return 'classic-pat';
  if (/^gh[ousr]_/.test(token)) return 'app-or-oauth-token';
  return 'unknown';
}

/** Rejects an obviously malformed credential before it is stored. */
export function validateTokenShape(token: string): string | null {
  const value = token.trim();
  if (value.length < 20) return 'credential is too short to be a GitHub token';
  if (/\s/.test(value)) return 'credential must not contain whitespace';
  if (!/^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/.test(value)) {
    return 'credential does not look like a GitHub token (expected github_pat_, ghp_, gho_, ghu_, ghs_ or ghr_ prefix)';
  }
  return null;
}

function infoFromRow(row: StoredRow): StoredCredentialInfo {
  return {
    source: 'database',
    fingerprint: row.fingerprint,
    tokenKind: row.token_kind,
    repo: row.repo,
    updatedAt: row.updated_at.toISOString(),
    configured: true,
  };
}

/**
 * Loads the stored credential into memory. Called on startup so the first
 * request after a restart already has it, and again after any admin change.
 * Never throws: a missing table or an unreachable database leaves the app on
 * the environment fallback rather than preventing startup.
 */
export async function loadStoredCredential(): Promise<StoredCredentialInfo> {
  if (!isDatabaseConfigured()) return credentialInfo() as StoredCredentialInfo;
  try {
    const res = await query<StoredRow>(
      `SELECT ciphertext, iv, auth_tag, fingerprint, token_kind, repo, updated_at
         FROM github_credentials WHERE id = 'default'`,
    );
    const row = res.rows[0];
    if (!row) {
      cachedDbInfo = null;
      return credentialInfo();
    }
    const token = decrypt(row);
    if (!token) {
      cachedDbInfo = null;
      return credentialInfo();
    }
    if (cachedToken && cachedToken !== token) forgetSecret(cachedToken);
    cachedToken = token;
    registerSecret(token);
    cachedDbInfo = infoFromRow(row);
    logger.info('stored GitHub credential loaded', {
      source: 'database',
      fingerprint: cachedDbInfo.fingerprint,
      tokenKind: cachedDbInfo.tokenKind,
    });
    return credentialInfo();
  } catch (err) {
    logger.warn('could not load stored GitHub credential', {
      error: err instanceof Error ? err.message : String(err),
    });
    return credentialInfo();
  }
}

/**
 * The credential to authenticate with, in precedence order:
 *   1. the credential stored by an admin (durable, app-owned),
 *   2. a fully configured GitHub App installation token,
 *   3. MY_AI_STUDIO_GITHUB_TOKEN from the deployment environment.
 *
 * The host-injected GITHUB_TOKEN is deliberately not consulted: it belongs to
 * the hosting runtime, not to this app, and relying on it is what made the
 * integration read-only and non-durable.
 */
export function resolvedToken(): { token: string | null; source: CredentialSource } {
  if (cachedToken) return { token: cachedToken, source: 'database' };
  if (config.githubAppId && config.githubAppPrivateKey && config.githubAppInstallationId) {
    return { token: null, source: 'app' };
  }
  if (config.githubToken) return { token: config.githubToken, source: 'env' };
  return { token: null, source: 'none' };
}

/**
 * Non-secret view of the credential state for status endpoints and the UI.
 *
 * Derived from the current source on every call rather than from a cached
 * snapshot, so a deployment that changes its own configuration (or a test that
 * mutates it) is reflected immediately.
 */
export function credentialInfo(): StoredCredentialInfo {
  if (cachedToken && cachedDbInfo) return { ...cachedDbInfo };
  if (config.githubAppId && config.githubAppPrivateKey && config.githubAppInstallationId) {
    return {
      source: 'app',
      fingerprint: null,
      tokenKind: 'github-app',
      repo: config.githubRepo || null,
      updatedAt: null,
      configured: true,
    };
  }
  if (config.githubToken) {
    return {
      source: 'env',
      fingerprint: fingerprintOf(config.githubToken),
      tokenKind: tokenKindOf(config.githubToken),
      repo: config.githubRepo || null,
      updatedAt: null,
      configured: true,
    };
  }
  return { source: 'none', fingerprint: null, tokenKind: null, repo: null, updatedAt: null, configured: false };
}

/** Saves or replaces the stored credential and refreshes the in-memory copy. */
export async function saveStoredCredential(
  token: string,
  repo: string | null,
  updatedBy: string | null,
): Promise<StoredCredentialInfo> {
  const value = token.trim();
  const { ciphertext, iv, authTag } = encrypt(value);
  const fingerprint = fingerprintOf(value);
  const tokenKind = tokenKindOf(value);
  const res = await query<StoredRow>(
    `INSERT INTO github_credentials (id, ciphertext, iv, auth_tag, fingerprint, token_kind, repo, updated_by, updated_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (id) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext,
           iv = EXCLUDED.iv,
           auth_tag = EXCLUDED.auth_tag,
           fingerprint = EXCLUDED.fingerprint,
           token_kind = EXCLUDED.token_kind,
           repo = EXCLUDED.repo,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()
     RETURNING ciphertext, iv, auth_tag, fingerprint, token_kind, repo, updated_at`,
    [ciphertext, iv, authTag, fingerprint, tokenKind, repo, updatedBy],
  );
  if (cachedToken && cachedToken !== value) forgetSecret(cachedToken);
  cachedToken = value;
  registerSecret(value);
  cachedDbInfo = infoFromRow(res.rows[0]);
  logger.info('stored GitHub credential replaced', {
    source: 'database',
    fingerprint,
    tokenKind,
    updatedBy,
  });
  return { ...cachedDbInfo };
}

/** Removes the stored credential, leaving any environment fallback in place. */
export async function clearStoredCredential(): Promise<StoredCredentialInfo> {
  await query(`DELETE FROM github_credentials WHERE id = 'default'`);
  if (cachedToken) forgetSecret(cachedToken);
  cachedToken = null;
  cachedDbInfo = null;
  logger.info('stored GitHub credential cleared');
  return credentialInfo();
}

/** Compares a candidate against the stored credential without revealing either. */
export function matchesStored(candidate: string): boolean {
  if (!cachedToken) return false;
  const a = Buffer.from(fingerprintOf(candidate));
  const b = Buffer.from(fingerprintOf(cachedToken));
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface CredentialProbe {
  ok: boolean;
  login: string | null;
  scopes: string | null;
  repo: string | null;
  canRead: boolean;
  canWrite: boolean | null;
  actions: boolean | null;
  error: string | null;
}

/**
 * Verifies a candidate credential against GitHub with real requests.
 *
 * The candidate is used for this call only and is never stored or logged. The
 * write probe posts a blob that nothing references, so it proves write access
 * without touching a branch, a commit or the working tree.
 */
export async function probeCredential(token: string, repo: string | null): Promise<CredentialProbe> {
  const base = config.githubApiBaseUrl.replace(/\/+$/, '');
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'my-ai-studio',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${token}`,
  };
  const result: CredentialProbe = {
    ok: false,
    login: null,
    scopes: null,
    repo,
    canRead: false,
    canWrite: null,
    actions: null,
    error: null,
  };
  try {
    const who = await fetch(`${base}/user`, { headers, signal: AbortSignal.timeout(config.githubTimeoutMs) });
    if (!who.ok) {
      result.error = `credential rejected by GitHub with HTTP ${who.status}`;
      return result;
    }
    const whoBody = (await who.json().catch(() => ({}))) as { login?: string };
    result.login = whoBody.login ?? null;
    result.scopes = who.headers.get('x-oauth-scopes');

    if (!repo) {
      result.ok = true;
      result.canRead = true;
      result.error = 'credential is valid; no repository configured to probe';
      return result;
    }

    const read = await fetch(`${base}/repos/${repo}`, { headers, signal: AbortSignal.timeout(config.githubTimeoutMs) });
    result.canRead = read.ok;
    if (!read.ok) {
      result.error = `credential cannot read ${repo} (HTTP ${read.status})`;
      return result;
    }

    const write = await fetch(`${base}/repos/${repo}/git/blobs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'probe', encoding: 'utf-8' }),
      signal: AbortSignal.timeout(config.githubTimeoutMs),
    });
    result.canWrite = write.ok || !(write.status === 403 || write.status === 404);

    const dispatch = await fetch(`${base}/repos/${repo}/actions/workflows/${encodeURIComponent(config.githubWorkflow)}/dispatches`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: '__my_ai_studio_capability_probe__' }),
      signal: AbortSignal.timeout(config.githubTimeoutMs),
    });
    result.actions = [200, 201, 204, 422].includes(dispatch.status)
      ? true
      : [403, 404].includes(dispatch.status) ? false : null;

    result.ok = true;
    return result;
  } catch (err) {
    // A network failure must not echo the token; the message is passed through
    // the redactor because a fetch error can include the request URL.
    result.error = `probe failed: ${redact(err instanceof Error ? err.message : String(err))}`;
    return result;
  }
}
