#!/usr/bin/env node
/**
 * Rewrites url.json with a new public base URL.
 *
 * url.json is the external source of truth an already-installed APK reads to
 * discover where My AI Studio currently lives. That is why this file is
 * committed to the public repository: raw.githubusercontent.com keeps serving it
 * after the OpenHands runtime that wrote it is gone.
 *
 * It holds a public URL and nothing else. Never write a token, key or password
 * here - the file is world-readable by design.
 *
 * Usage:
 *   node scripts/url-json-update.mjs --url https://host [--status online] [--dry-run]
 *   MY_AI_STUDIO_DOMAIN=host node scripts/url-json-update.mjs
 *
 * Exits non-zero on failure so a watchdog can detect a failed publish.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(REPO_ROOT, 'url.json');
const SCHEMA = 1;

const VALID_STATUS = new Set(['online', 'offline', 'unknown']);

function parseArgs(argv) {
  const args = { status: 'online', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--url') args.url = argv[++i];
    else if (arg === '--status') args.status = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/**
 * Accepts a bare host, an absolute URL, or the OpenHands domain variable, and
 * always returns a normalised origin with no trailing slash. Rejects anything
 * that is not plain http(s) so a bad value cannot smuggle a scheme such as
 * javascript: into every future APK.
 */
function normaliseUrl(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.origin;
}

async function readExisting() {
  try {
    const raw = await readFile(TARGET, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Confirms the candidate host actually serves My AI Studio before publishing it.
 * A URL that 404s would strand every installed APK, so this is a hard gate.
 * Returns { ok, detail } and never throws.
 */
async function probe(base) {
  try {
    const res = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'my-ai-studio-url-publisher' },
    });
    if (!res.ok) return { ok: false, detail: `health returned HTTP ${res.status}` };
    const body = await res.json();
    if (body?.service !== 'my-ai-studio') {
      return { ok: false, detail: `unexpected service field: ${String(body?.service)}` };
    }
    return { ok: true, detail: `service=${body.service} version=${body.version ?? 'n/a'}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const candidate = args.url ?? process.env.MY_AI_STUDIO_DOMAIN ?? process.env.URL_JSON_URL;
  const url = normaliseUrl(candidate);
  if (!url) {
    console.error('FAILED: no usable URL. Pass --url or set MY_AI_STUDIO_DOMAIN.');
    process.exit(1);
  }
  if (!VALID_STATUS.has(args.status)) {
    console.error(`FAILED: --status must be one of ${[...VALID_STATUS].join(', ')}`);
    process.exit(1);
  }

  // Refuse to publish a URL we cannot verify. --dry-run lets the watchdog inspect
  // a candidate without touching the committed file.
  const health = await probe(url);
  if (!health.ok) {
    console.error(`FAILED: ${url} is not serving My AI Studio - ${health.detail}`);
    process.exit(1);
  }
  console.log(`verified: ${url} (${health.detail})`);

  const existing = await readExisting();

  // A change to the URL is what an installed APK acts on. Logging it makes the
  // switch auditable from CI output alone.
  const changed = existing.url !== url;

  const payload = {
    schema: SCHEMA,
    service: 'my-ai-studio',
    url,
    previousUrl: changed && existing.url ? existing.url : null,
    updatedAt: new Date().toISOString(),
    status: args.status,
  };

  const serialised = `${JSON.stringify(payload, null, 2)}\n`;

  if (args.dryRun) {
    console.log('dry-run: would write');
    process.stdout.write(serialised);
    return;
  }

  if (!changed && existing.status === args.status) {
    console.log('no change: url and status already current');
    return;
  }

  await writeFile(TARGET, serialised, 'utf8');
  console.log(`wrote ${TARGET}`);
  if (changed) console.log(`url changed: ${existing.url ?? '(none)'} -> ${url}`);
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
