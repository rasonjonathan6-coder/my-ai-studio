/**
 * Tests for reading url.json and deciding alive / dead / unknown.
 *
 * The network is faked here, and only here: these tests are about the decision
 * logic, and a real fetch would make the outcome depend on whatever the studio
 * happens to be doing. The real network path is exercised separately by the
 * --plan run against the live url.json, which is recorded in the step 4 report.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { VERDICT, checkStudioHealth, readStudioUrl } from '../src/discovery.mjs';

const SETTINGS = {
  documentUrl: 'https://example.invalid/url.json',
  healthAttempts: 3,
  healthDelayMs: 0,
  healthTimeoutMs: 1_000,
  documentTimeoutMs: 1_000,
};

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const DOCUMENT = {
  schema: 1,
  service: 'my-ai-studio',
  url: 'https://studio.example',
  previousUrl: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'online',
};

function documentFetch(body, options) {
  return async () => jsonResponse(body, options);
}

const noSleep = async () => {};

describe('readStudioUrl', () => {
  it('reads the address and normalises it to an origin', async () => {
    const result = await readStudioUrl(SETTINGS, documentFetch(DOCUMENT));
    assert.equal(result.url, 'https://studio.example');
  });

  it('drops a path so callers do not inherit it', async () => {
    const result = await readStudioUrl(
      SETTINGS,
      documentFetch({ ...DOCUMENT, url: 'https://studio.example/prefix' }),
    );
    assert.equal(result.url, 'https://studio.example');
  });

  it('keeps a port', async () => {
    const result = await readStudioUrl(
      SETTINGS,
      documentFetch({ ...DOCUMENT, url: 'https://studio.example:8443' }),
    );
    assert.equal(result.url, 'https://studio.example:8443');
  });

  it('refuses a document for another service', async () => {
    await assert.rejects(
      () => readStudioUrl(SETTINGS, documentFetch({ ...DOCUMENT, service: 'something-else' })),
      /not for this service/,
    );
  });

  it('refuses an unsupported schema rather than guessing', async () => {
    await assert.rejects(
      () => readStudioUrl(SETTINGS, documentFetch({ ...DOCUMENT, schema: 2 })),
      /unsupported discovery schema/,
    );
  });

  it('refuses a document with no url', async () => {
    const { url, ...withoutUrl } = DOCUMENT;
    await assert.rejects(() => readStudioUrl(SETTINGS, documentFetch(withoutUrl)), /has no url/);
  });

  it('refuses a non-http scheme', async () => {
    await assert.rejects(
      () => readStudioUrl(SETTINGS, documentFetch({ ...DOCUMENT, url: 'file:///etc/passwd' })),
      /not http/,
    );
  });

  it('fails when the document cannot be fetched', async () => {
    await assert.rejects(
      () => readStudioUrl(SETTINGS, async () => jsonResponse({}, { status: 500 })),
      /HTTP 500/,
    );
  });

  it('fails when the document is not JSON', async () => {
    await assert.rejects(
      () =>
        readStudioUrl(SETTINGS, async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('not json');
          },
        })),
      /not valid JSON/,
    );
  });

  it('never falls back to a hardcoded host', async () => {
    // A guessed address could point the watchdog at an unrelated service, so an
    // unreadable document must fail rather than resolve to anything.
    await assert.rejects(() => readStudioUrl(SETTINGS, async () => jsonResponse({}, { status: 404 })));
  });
});

describe('checkStudioHealth', () => {
  it('reports alive on a healthy response', async () => {
    const result = await checkStudioHealth(
      'https://studio.example',
      SETTINGS,
      { sleep: noSleep, fetchImpl: async () => jsonResponse({ ok: true, service: 'my-ai-studio' }) },
    );
    assert.equal(result.verdict, VERDICT.ALIVE);
  });

  it('reports dead immediately on a 404 without retrying', async () => {
    // A host that answers 404 is up and simply is not the studio; retrying would
    // only waste time.
    let calls = 0;
    const result = await checkStudioHealth('https://studio.example', SETTINGS, {
      sleep: noSleep,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({}, { status: 404 });
      },
    });
    assert.equal(result.verdict, VERDICT.DEAD);
    assert.equal(calls, 1);
  });

  it('reports dead when the host serves a different service', async () => {
    const result = await checkStudioHealth('https://studio.example', SETTINGS, {
      sleep: noSleep,
      fetchImpl: async () => jsonResponse({ ok: true, service: 'someone-else' }),
    });
    assert.equal(result.verdict, VERDICT.DEAD);
  });

  it('reports unknown when every attempt fails transiently', async () => {
    // This is the case that must NOT rebuild: DNS blips and sleeping laptops
    // look exactly like this.
    const result = await checkStudioHealth('https://studio.example', SETTINGS, {
      sleep: noSleep,
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      },
    });
    assert.equal(result.verdict, VERDICT.UNKNOWN);
    assert.equal(result.attempts.length, SETTINGS.healthAttempts);
  });

  it('retries a transient failure and succeeds when the host comes back', async () => {
    let calls = 0;
    const result = await checkStudioHealth('https://studio.example', SETTINGS, {
      sleep: noSleep,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) throw new Error('temporary failure');
        return jsonResponse({ ok: true, service: 'my-ai-studio' });
      },
    });
    assert.equal(result.verdict, VERDICT.ALIVE);
    assert.equal(calls, 3);
  });

  it('does not rebuild when the studio answers but reports unhealthy', async () => {
    // The process is up and reachable; a fresh runtime would not fix its
    // internal problem, so this is left for the next cycle.
    const result = await checkStudioHealth('https://studio.example', SETTINGS, {
      sleep: noSleep,
      fetchImpl: async () => jsonResponse({ ok: false, service: 'my-ai-studio' }),
    });
    assert.equal(result.verdict, VERDICT.UNKNOWN);
  });

  it('reports dead when health returns a non-JSON body', async () => {
    const result = await checkStudioHealth('https://studio.example', SETTINGS, {
      sleep: noSleep,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('html');
        },
      }),
    });
    assert.equal(result.verdict, VERDICT.DEAD);
  });
});
