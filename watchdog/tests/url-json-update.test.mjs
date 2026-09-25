/**
 * Tests for scripts/url-json-update.mjs, the writer of url.json.
 *
 * This script had no tests before, which is the gap that matters most here: it
 * produces the one file an already-installed APK reads to find the studio, and
 * a wrong value in it strands every install. The assertions below pin the
 * properties that make it safe to run unattended:
 *
 *  - it never writes a host that does not answer /api/health as my-ai-studio;
 *  - a failure, a dry run or a rejected URL leaves the existing document byte
 *    for byte as it was, so a bad attempt cannot point installs at nothing;
 *  - the old address is carried into previousUrl rather than being lost;
 *  - updatedAt is generated, not copied;
 *  - nothing resembling a credential can reach the published document.
 *
 * The script resolves url.json relative to its own location, so each test gets
 * an isolated copy of both under a temp directory. The real url.json is never
 * opened by anything here.
 *
 * The healthy and unhealthy hosts are real HTTP servers on loopback: the health
 * gate is the whole point of the script, so faking fetch would test the fake
 * instead of the gate.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLISHER_SRC = join(REPO_ROOT, 'scripts', 'url-json-update.mjs');

const OLD_URL = 'https://old-runtime.example';
const OLD_UPDATED_AT = '2020-01-01T00:00:00.000Z';

const openServers = [];
const tempRoots = [];

/** A real HTTP server whose /api/health answer the test chooses. */
async function startStudioServer({ service = 'my-ai-studio', status = 200 } = {}) {
  const state = { service, status };
  const server = createServer((req, res) => {
    if (req.url !== '/api/health') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    if (state.status !== 200) {
      res.writeHead(state.status, { 'content-type': 'text/plain' }).end('bad gateway');
      return;
    }
    const body = JSON.stringify({ ok: true, service: state.service, version: '1.0.0' });
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const handle = {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
  openServers.push(handle);
  return handle;
}

/** A committed-document fixture. */
function document({ url = OLD_URL, status = 'online', updatedAt = OLD_UPDATED_AT } = {}) {
  return { schema: 1, service: 'my-ai-studio', url, previousUrl: null, updatedAt, status };
}

/**
 * An isolated copy of the publisher plus the url.json it will rewrite, so the
 * committed file is never a target.
 */
async function isolatedCopy({ existing = document() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'url-json-'));
  tempRoots.push(root);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await cp(PUBLISHER_SRC, join(root, 'scripts', 'url-json-update.mjs'));
  await writeFile(join(root, 'url.json'), `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
  return root;
}

const documentPath = (root) => join(root, 'url.json');
const readDocument = (root) => readFile(documentPath(root), 'utf8');

/** Runs the real script and resolves with its exit code and output. */
function runPublisher(root, ...args) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'url-json-update.mjs'), ...args], {
      env: {
        ...process.env,
        // Both are alternative URL sources in the script and both are set in
        // this environment. Cleared so a test that passes no --url is testing
        // the missing-URL path rather than the operator's shell.
        MY_AI_STUDIO_DOMAIN: '',
        URL_JSON_URL: '',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, output: `${stdout}${stderr}` });
    });
  });
}

after(async () => {
  await Promise.all(openServers.map((handle) => handle.close()));
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

let studio;
let impostor;

before(async () => {
  studio = await startStudioServer();
  impostor = await startStudioServer({ service: 'something-else' });
});

describe('url-json-update: publishing a verified URL', () => {
  it('writes the new URL and carries the old one into previousUrl', async () => {
    const root = await isolatedCopy();
    const { code } = await runPublisher(root, '--url', studio.url, '--status', 'online');

    assert.equal(code, 0);
    const published = JSON.parse(await readDocument(root));
    assert.equal(published.schema, 1);
    assert.equal(published.service, 'my-ai-studio');
    assert.equal(published.url, studio.url);
    assert.equal(published.previousUrl, OLD_URL);
    assert.equal(published.status, 'online');
  });

  it('generates updatedAt as a canonical ISO timestamp', async () => {
    const root = await isolatedCopy();
    await runPublisher(root, '--url', studio.url, '--status', 'online');

    const published = JSON.parse(await readDocument(root));
    assert.ok(!Number.isNaN(Date.parse(published.updatedAt)), 'updatedAt is not parseable');
    // Canonical form: re-serialising must be a no-op.
    assert.equal(new Date(published.updatedAt).toISOString(), published.updatedAt);
    // Compared against the fixture rather than a hardcoded clock.
    assert.ok(
      Date.parse(published.updatedAt) > Date.parse(OLD_UPDATED_AT),
      'updatedAt did not move forward',
    );
  });

  it('moves updatedAt forward again on a second publish', async () => {
    const root = await isolatedCopy();
    await runPublisher(root, '--url', studio.url, '--status', 'online');
    const first = JSON.parse(await readDocument(root));

    // A second, genuinely different host, so the write is not skipped as a
    // no-op by the "url and status already current" branch.
    const other = await startStudioServer();
    await runPublisher(root, '--url', other.url, '--status', 'online');
    const second = JSON.parse(await readDocument(root));

    assert.equal(second.url, other.url);
    assert.equal(second.previousUrl, studio.url);
    assert.notEqual(second.updatedAt, first.updatedAt, 'updatedAt was reused');
    assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
  });

  it('records no previousUrl when the document had no url to replace', async () => {
    const root = await isolatedCopy({ existing: { schema: 1, service: 'my-ai-studio' } });
    await runPublisher(root, '--url', studio.url, '--status', 'online');

    const published = JSON.parse(await readDocument(root));
    assert.equal(published.url, studio.url);
    assert.equal(published.previousUrl, null);
  });

  it('leaves the document untouched when the url and status are already current', async () => {
    const root = await isolatedCopy({ existing: document({ url: studio.url }) });
    const before = await readDocument(root);

    const { code } = await runPublisher(root, '--url', studio.url, '--status', 'online');

    assert.equal(code, 0);
    assert.equal(await readDocument(root), before, 'an idempotent publish rewrote the file');
  });
});

describe('url-json-update: the health gate', () => {
  it('refuses a host that is not serving the studio and writes nothing', async () => {
    const broken = await startStudioServer({ status: 404 });
    const root = await isolatedCopy();
    const before = await readDocument(root);

    const { code, output } = await runPublisher(root, '--url', broken.url, '--status', 'online');

    assert.notEqual(code, 0);
    assert.match(output, /is not serving My AI Studio/);
    // The property that matters: a failed attempt leaves the committed address
    // exactly as it was, so installs keep following a known-good host.
    assert.equal(await readDocument(root), before, 'a rejected URL still rewrote the file');
  });

  it('refuses a host that answers health but is not this service', async () => {
    const root = await isolatedCopy();
    const before = await readDocument(root);

    const { code, output } = await runPublisher(root, '--url', impostor.url, '--status', 'online');

    assert.notEqual(code, 0);
    assert.match(output, /unexpected service field/);
    assert.equal(await readDocument(root), before);
  });

  it('refuses an unreachable host', async () => {
    const root = await isolatedCopy();
    const before = await readDocument(root);

    const { code } = await runPublisher(root, '--url', 'http://127.0.0.1:1', '--status', 'online');

    assert.notEqual(code, 0);
    assert.equal(await readDocument(root), before);
  });
});

describe('url-json-update: --dry-run', () => {
  it('never writes, even for a healthy verified URL', async () => {
    const root = await isolatedCopy();
    const before = await readDocument(root);

    const { code, stdout } = await runPublisher(root, '--url', studio.url, '--dry-run');

    assert.equal(code, 0);
    assert.match(stdout, /dry-run: would write/);
    assert.match(stdout, /previousUrl/);
    assert.equal(await readDocument(root), before, '--dry-run rewrote the file');
  });

  it('reports what it would write without changing the existing url', async () => {
    const root = await isolatedCopy();
    const { stdout } = await runPublisher(root, '--url', studio.url, '--dry-run');

    // The preview must name the candidate, not the stale committed address.
    assert.match(stdout, new RegExp(studio.url.replace(/[.:]/g, '\\$&')));
    assert.doesNotMatch(stdout, /"url": "https:\/\/old-runtime\.example"/);
  });
});

describe('url-json-update: rejecting unusable URLs', () => {
  // Two different defences, tested separately because conflating them would
  // hide which one fired. Validation rejects a value outright; anything that
  // survives it is still stopped by the health gate, so the two together mean
  // no unusable host can ever be published.
  const rejectedByValidation = [
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a scheme-less malformed value', 'http://'],
    ['an empty value', ''],
    ['free text that is not a URL', 'not a url'],
  ];

  for (const [label, candidate] of rejectedByValidation) {
    it(`refuses ${label} outright`, async () => {
      const root = await isolatedCopy();
      const before = await readDocument(root);

      // The studio URL is healthy here on purpose: rejection must come from
      // validating the candidate, not from the health check happening to fail.
      const { code, output } = await runPublisher(root, '--url', candidate, '--status', 'online');

      assert.notEqual(code, 0, `${label} was accepted`);
      assert.match(output, /no usable URL/);
      assert.equal(await readDocument(root), before);
    });
  }

  // A value carrying another scheme is not a scheme-smuggling route: the
  // normaliser prefixes anything without http(s) and then asserts the parsed
  // protocol, so the origin that comes out is always http(s). What it does not
  // do is reject an odd hostname - `file:///etc/passwd` becomes the host
  // `file` and `ftp://evil.example` becomes `ftp`. Both are then refused by the
  // health gate, which is asserted here rather than assumed: the published
  // document can only ever name a host that answered as my-ai-studio.
  const neutralisedThenBlocked = [
    ['a file: scheme', 'file:///etc/passwd', 'https://file'],
    ['an ftp: scheme', 'ftp://evil.example', 'https://ftp'],
  ];

  for (const [label, candidate, coerced] of neutralisedThenBlocked) {
    it(`neutralises ${label} to ${coerced} and then refuses it`, async () => {
      const root = await isolatedCopy();
      const before = await readDocument(root);

      const { code, output } = await runPublisher(root, '--url', candidate, '--status', 'online');

      assert.notEqual(code, 0, `${label} was published`);
      // It got past validation as a plain https origin, and the health gate is
      // what stopped it.
      assert.match(output, new RegExp(`FAILED: ${coerced.replace(/[.:/]/g, '\\$&')} is not serving`));
      assert.equal(await readDocument(root), before);
    });
  }

  it('refuses an unknown status', async () => {
    const root = await isolatedCopy();
    const before = await readDocument(root);

    const { code, output } = await runPublisher(root, '--url', studio.url, '--status', 'bogus');

    assert.notEqual(code, 0);
    assert.match(output, /--status must be one of/);
    assert.equal(await readDocument(root), before);
  });

  it('refuses an unknown argument', async () => {
    const root = await isolatedCopy();
    const { code, output } = await runPublisher(root, '--bogus');

    assert.notEqual(code, 0);
    assert.match(output, /unknown argument/);
  });
});

describe('url-json-update: no credential can reach the output', () => {
  it('publishes no secret and prints none', async () => {
    // Synthetic values, shaped so a scanner recognises the prefix but no reader
    // can mistake them for a live credential. Assembled at runtime rather than
    // written as literals: the repository's own secret scan checks
    // watchdog/tests too, and a credential-shaped literal here would fail it.
    const fixtures = {
      OPENROUTER_API_KEY: `sk-or-v1-${'fixture'.repeat(4)}`,
      OPENHANDS_API_KEY: `sk-${'openhands'.repeat(3)}`,
      GITHUB_TOKEN: `ghp_${'F'.repeat(30)}`,
      DATABASE_URL: ['postgres://', 'fixtureuser', ':', 'fixturepassword', '@127.0.0.1:5432/fixturedb'].join(''),
      JWT_SECRET: `jwt-${'fixture'.repeat(3)}`,
    };

    const root = await isolatedCopy();
    const child = await new Promise((done, fail) => {
      const proc = spawn(process.execPath, [join(root, 'scripts', 'url-json-update.mjs'), '--url', studio.url], {
        env: { ...process.env, ...fixtures, MY_AI_STUDIO_DOMAIN: '', URL_JSON_URL: '' },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => {
        stdout += c;
      });
      proc.stderr.on('data', (c) => {
        stderr += c;
      });
      proc.on('error', fail);
      proc.on('close', () => done({ stdout, stderr }));
    });

    const published = await readDocument(root);
    const transcript = `${child.stdout}${child.stderr}`;
    for (const [name, value] of Object.entries(fixtures)) {
      assert.ok(!published.includes(value), `${name} reached url.json`);
      // The password half is what must never appear; the scheme alone is fine.
      const sensitive = name === 'DATABASE_URL' ? 'fixturepassword' : value;
      assert.ok(!transcript.includes(sensitive), `${name} was printed`);
    }
    assert.equal(JSON.parse(published).service, 'my-ai-studio');
  });
});
