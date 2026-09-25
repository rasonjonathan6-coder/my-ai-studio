/**
 * The sandbox lifecycle, exercised against a fake HTTP layer.
 *
 * Two failures motivated these tests, and neither was reachable before because
 * `startSandbox` and `getSandbox` were covered only through `recoverStudio` with a
 * hand-written client that always answered successfully:
 *
 *  - run 36156520637 created sandbox 7ab3DU3awDW8DSHDTOpYG3, waited five minutes
 *    while it stayed STARTING, and then failed. The sandbox was left behind - it
 *    was still in the account afterwards, and only later flipped to ERROR - because
 *    the id lived inside `startSandbox` and the caller that wanted to clean up had
 *    never been given it.
 *  - `getSandbox` scanned the first 50 entries of the paginated search endpoint, so
 *    a sandbox could be reported missing simply by falling off the end of a page.
 *
 * `OpenHandsClient` takes its fetch implementation by constructor, so the whole
 * sequence is driven here without a network call. The credential is a literal
 * stand-in, never a real key, and one test asserts it cannot reach a log line.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ApiError, OpenHandsClient, SandboxShell } from '../src/openhandsClient.mjs';

const SANDBOX_ID = '7ab3DU3awDW8DSHDTOpYG3';
const CREDENTIAL = 'unit-test-credential';
const BASE = 'https://app.example.invalid';

/** A fetch-shaped response, using the real Response so res.text()/res.ok behave. */
function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fake OpenHands API.
 *
 * `statuses` is the sequence the id endpoint reports, one entry per poll; the last
 * entry repeats once the sequence is exhausted, which is how a permanently
 * STARTING sandbox is expressed.
 */
function fakeApi({
  statuses = ['STARTING'],
  statusDetail = null,
  sandboxId = SANDBOX_ID,
  deleteFails = false,
  getId = null,
} = {}) {
  const calls = [];
  let polls = 0;

  const fetchImpl = async (url, options = {}) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const parsed = new URL(url);
    const entry = { method, path: parsed.pathname, id: parsed.searchParams.get('id'), url };
    calls.push(entry);

    if (method === 'POST' && parsed.pathname === '/api/v1/sandboxes') {
      return reply(200, { id: sandboxId, status: 'STARTING', session_api_key: null });
    }

    if (method === 'GET' && parsed.pathname === '/api/v1/sandboxes') {
      // The dedicated endpoint carries the id; the search endpoint does not.
      if (parsed.searchParams.has('id') && getId) {
        const custom = getId(parsed.searchParams.get('id'));
        return reply(200, custom);
      }
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      entry.poll = polls;
      return reply(200, [{ id: sandboxId, status, status_detail: statusDetail }]);
    }

    if (method === 'DELETE') {
      if (deleteFails) return reply(500, { detail: 'delete refused' });
      return reply(200, { success: true });
    }

    return reply(404, { detail: `no route for ${method} ${parsed.pathname}` });
  };

  return { fetchImpl, calls, polls: () => polls };
}

/** Builds a client wired to a fake API. */
function clientFor(api, overrides = {}) {
  return new OpenHandsClient({
    baseUrl: BASE,
    credential: CREDENTIAL,
    fetchImpl: api.fetchImpl,
    ...overrides,
  });
}

const deletes = (calls) => calls.filter((c) => c.method === 'DELETE');
const gets = (calls) => calls.filter((c) => c.method === 'GET');

describe('OpenHandsClient sandbox id lookup', () => {
  it('reads a sandbox through the id endpoint, not the paginated search', async () => {
    const api = fakeApi({ getId: () => [{ id: SANDBOX_ID, status: 'RUNNING' }] });
    const client = clientFor(api);

    const found = await client.getSandbox(SANDBOX_ID);

    assert.equal(found.status, 'RUNNING');
    const get = gets(api.calls)[0];
    assert.equal(get.path, '/api/v1/sandboxes');
    assert.equal(get.id, SANDBOX_ID, 'the id was not sent as a query parameter');
    // Searching is what made a live sandbox look absent once an account held more
    // than one page of them.
    assert.ok(
      !api.calls.some((c) => c.path.includes('/search')),
      'the lookup still goes through the paginated search endpoint',
    );
  });

  it('returns null when the sandbox is gone, without throwing', async () => {
    const api = fakeApi({ getId: () => [null] });
    const client = clientFor(api);

    assert.equal(await client.getSandbox(SANDBOX_ID), null);
  });

  it('accepts an unwrapped object as well as a single-element list', async () => {
    const api = fakeApi({ getId: () => ({ id: SANDBOX_ID, status: 'PAUSED' }) });
    const client = clientFor(api);

    const found = await client.getSandbox(SANDBOX_ID);
    assert.equal(found.status, 'PAUSED');
  });
});

describe('OpenHandsClient startSandbox: a sandbox that never runs', () => {
  it('discards a sandbox left in STARTING and reports the timeout', async () => {
    // The exact shape of run 36156520637: created STARTING, never changed, timed out.
    const api = fakeApi({ statuses: ['STARTING'] });
    const client = clientFor(api);

    await assert.rejects(
      () => client.startSandbox({ timeoutMs: 25, pollIntervalMs: 1 }),
      (err) => {
        assert.ok(err instanceof ApiError, 'the timeout must surface as an ApiError');
        assert.match(err.message, /did not reach RUNNING/);
        assert.match(err.message, new RegExp(SANDBOX_ID));
        return true;
      },
    );

    const removed = deletes(api.calls);
    assert.equal(removed.length, 1, 'the stalled sandbox was not discarded');
    assert.equal(
      new URL(removed[0].url).searchParams.get('sandbox_id'),
      SANDBOX_ID,
      'the wrong sandbox was discarded',
    );
    assert.equal(removed[0].path, `/api/v1/sandboxes/${SANDBOX_ID}`);
  });

  it('carries status_detail into the timeout error when the platform gives one', async () => {
    const api = fakeApi({ statuses: ['STARTING'], statusDetail: 'insufficient kvm' });
    const client = clientFor(api);

    await assert.rejects(
      () => client.startSandbox({ timeoutMs: 25, pollIntervalMs: 1 }),
      (err) => {
        assert.equal(err.detail.status, 'STARTING');
        assert.equal(
          err.detail.status_detail,
          'insufficient kvm',
          'the reason the platform gave for the stall was dropped',
        );
        return true;
      },
    );
  });

  it('reports a null status_detail rather than inventing one', async () => {
    // The stalled sandbox in production returned status_detail: null throughout, so
    // the error must be able to say "the platform gave no reason" honestly.
    const api = fakeApi({ statuses: ['STARTING'], statusDetail: null });
    const client = clientFor(api);

    await assert.rejects(
      () => client.startSandbox({ timeoutMs: 25, pollIntervalMs: 1 }),
      (err) => {
        assert.equal(err.detail.status_detail, null);
        return true;
      },
    );
  });
});

describe('OpenHandsClient startSandbox: terminal statuses', () => {
  for (const status of ['ERROR', 'MISSING']) {
    it(`fails immediately on ${status} instead of polling to the timeout`, async () => {
      const api = fakeApi({ statuses: [status] });
      const client = clientFor(api);

      // The timeout is deliberately much larger than the test's own patience: a
      // terminal status must fail on the first poll. Were it not treated as
      // terminal the loop would keep polling for the whole timeout and the error
      // would be a timeout rather than the status, which is what the assertions
      // below catch - without the test itself having to wait minutes to say so.
      const timeoutMs = 4_000;
      const started = Date.now();
      await assert.rejects(
        () => client.startSandbox({ timeoutMs, pollIntervalMs: 1 }),
        (err) => {
          assert.match(
            err.message,
            new RegExp(`entered ${status}`),
            `${status} was not treated as terminal: ${err.message}`,
          );
          return true;
        },
      );
      const elapsed = Date.now() - started;

      assert.ok(
        elapsed < timeoutMs / 2,
        `${status} was polled for ${elapsed}ms, so it is not treated as terminal`,
      );
      assert.equal(
        api.polls(),
        1,
        `${status} was polled more than once, so it is not treated as terminal`,
      );
      assert.equal(deletes(api.calls).length, 1, 'a terminal sandbox should still be discarded');
    });
  }

  it('reports status_detail from a terminal sandbox', async () => {
    const api = fakeApi({ statuses: ['ERROR'], statusDetail: 'ImagePullBackOff' });
    const client = clientFor(api);

    await assert.rejects(
      () => client.startSandbox({ timeoutMs: 300_000, pollIntervalMs: 1 }),
      (err) => {
        assert.equal(err.detail, 'ImagePullBackOff');
        return true;
      },
    );
  });
});

describe('OpenHandsClient startSandbox: a sandbox that runs', () => {
  it('returns the RUNNING sandbox and discards nothing', async () => {
    const api = fakeApi({ statuses: ['STARTING', 'RUNNING'] });
    const client = clientFor(api);

    const sandbox = await client.startSandbox({ timeoutMs: 1_000, pollIntervalMs: 1 });

    assert.equal(sandbox.status, 'RUNNING');
    assert.equal(sandbox.id, SANDBOX_ID);
    assert.equal(
      deletes(api.calls).length,
      0,
      'a sandbox that reached RUNNING must never be discarded',
    );
  });

  it('does not discard a sandbox when only the create call itself failed', async () => {
    // Creation returned no id, so there is nothing to own and nothing to delete.
    const fetchImpl = async () => reply(200, { status: 'STARTING' });
    const api = fakeApi();
    const client = new OpenHandsClient({
      baseUrl: BASE,
      credential: CREDENTIAL,
      fetchImpl: async (url, options = {}) =>
        (options.method ?? 'GET').toUpperCase() === 'POST' ? fetchImpl(url, options) : api.fetchImpl(url, options),
    });

    await assert.rejects(
      () => client.startSandbox({ timeoutMs: 25, pollIntervalMs: 1 }),
      /returned no id/,
    );
    assert.equal(api.calls.filter((c) => c.method === 'DELETE').length, 0);
  });
});

describe('OpenHandsClient startSandbox: cleanup must not mask the cause', () => {
  it('keeps the original error when the discard itself fails', async () => {
    const api = fakeApi({ statuses: ['ERROR'], deleteFails: true });
    const client = clientFor(api);

    await assert.rejects(
      () => client.startSandbox({ timeoutMs: 300_000, pollIntervalMs: 1 }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.match(
          err.message,
          /entered ERROR/,
          'the cleanup failure replaced the original error',
        );
        assert.doesNotMatch(err.message, /delete refused/);
        return true;
      },
    );

    assert.equal(deletes(api.calls).length, 1, 'the discard was not attempted');
  });

  it('keeps the original error when the discard fails on a timeout', async () => {
    const api = fakeApi({ statuses: ['STARTING'], deleteFails: true });
    const client = clientFor(api);

    await assert.rejects(
      () => client.startSandbox({ timeoutMs: 25, pollIntervalMs: 1 }),
      /did not reach RUNNING/,
    );
  });
});

describe('OpenHandsClient never logs its credential', () => {
  it('keeps the credential out of the lines it writes', async () => {
    const api = fakeApi({ statuses: ['ERROR'], statusDetail: 'boom' });
    const client = clientFor(api);

    const written = [];
    const capture = (stream) => {
      const original = stream.write.bind(stream);
      stream.write = (chunk, ...rest) => {
        written.push(String(chunk));
        return original(chunk, ...rest);
      };
      return () => {
        stream.write = original;
      };
    };
    const restoreOut = capture(process.stdout);
    const restoreErr = capture(process.stderr);
    try {
      await assert.rejects(() => client.startSandbox({ timeoutMs: 300_000, pollIntervalMs: 1 }));
    } finally {
      restoreOut();
      restoreErr();
    }

    const text = written.join('');
    assert.ok(text.length > 0, 'expected the client to log something');
    assert.ok(
      !text.includes(CREDENTIAL),
      'the credential reached a log line',
    );
  });
});

describe('SandboxShell.uploadFile', () => {
  const AGENT_URL = 'https://agent.example.invalid';

  /** A fetch that records the request and answers with the given status. */
  function fakeUpload({ status = 200, body = '{"ok":true}' } = {}) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url, method: options.method, headers: options.headers, body: options.body });
      return new Response(body, { status });
    };
    return { calls, fetchImpl };
  }

  function makeShell(fake) {
    return new SandboxShell({
      agentServerUrl: AGENT_URL,
      sessionApiKey: CREDENTIAL,
      fetchImpl: fake.fetchImpl,
    });
  }

  it('posts the content as a multipart body, not as a command', async () => {
    const fake = fakeUpload();
    const shell = makeShell(fake);
    const content = 'DATABASE_URL=postgres://u:p@h/db\n';
    await shell.uploadFile('/tmp/studio.env', content);

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.method, 'POST');
    assert.match(call.url, /\/api\/file\/upload\?path=%2Ftmp%2Fstudio\.env$/);
    assert.ok(call.body instanceof FormData, 'the body was not multipart');
    assert.equal(call.headers['X-Session-API-Key'], CREDENTIAL);
    // The content is readable from the form, which is where it belongs: it is the
    // request body, not an argument of a command.
    const sent = call.body.get('file');
    assert.equal(await sent.text(), content);
  });

  it('raises when the upload is refused, without echoing the content back', async () => {
    // An error must not become a second channel for what was being uploaded, so the
    // response body is deliberately not propagated into the message.
    const fake = fakeUpload({ status: 500, body: 'DATABASE_URL=postgres://u:p@h/db is invalid' });
    const shell = makeShell(fake);
    await assert.rejects(
      () => shell.uploadFile('/tmp/studio.env', 'DATABASE_URL=postgres://u:p@h/db\n'),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.match(err.message, /upload failed with HTTP 500/);
        assert.doesNotMatch(err.message, /postgres/);
        return true;
      },
    );
  });

  it('raises when the request cannot be made at all', async () => {
    const shell = new SandboxShell({
      agentServerUrl: AGENT_URL,
      sessionApiKey: CREDENTIAL,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    await assert.rejects(
      () => shell.uploadFile('/tmp/studio.env', 'X=1\n'),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.match(err.message, /upload could not run/);
        return true;
      },
    );
  });

  it('encodes a path that needs escaping rather than concatenating it raw', async () => {
    const fake = fakeUpload();
    const shell = makeShell(fake);
    await shell.uploadFile('/tmp/a b#c.env', 'X=1\n');
    assert.match(fake.calls[0].url, /path=%2Ftmp%2Fa%20b%23c\.env$/);
  });
});

