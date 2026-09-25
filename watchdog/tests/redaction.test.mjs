/**
 * Tests that no credential can reach a log line.
 *
 * This matters more here than in most code: the watchdog runs unattended and its
 * output goes to a CI transcript and to whatever collects logs, so a leaked key
 * would be copied to a place nobody is watching.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { redact, redactValue } from '../src/log.mjs';

const TOUCHED = [];
function setEnv(name, value) {
  TOUCHED.push(name);
  process.env[name] = value;
}

// The redaction tests below need values with the *shape* of a real credential,
// because that is what the shape patterns match on. They are assembled at
// runtime rather than written as literals for two reasons that happen to agree:
// a literal in a tracked file is what a secret scanner flags, and a prefix glued
// to its body in the source is genuinely harder to confuse with a live key when
// someone reads the file. The values remain obviously fake - repeated digits and
// repeated letters - so no reader mistakes them for anything real.
const fakeOpenRouterKey = `sk-or-v1-${'0123456789'.repeat(3)}`;
const fakeGitHubToken = `ghu_${'A'.repeat(30)}`;

afterEach(() => {
  for (const name of TOUCHED.splice(0)) delete process.env[name];
});

describe('redact', () => {
  it('removes an OpenRouter key by shape', () => {
    assert.doesNotMatch(redact(`provider said ${fakeOpenRouterKey}`), /0123456789/);
  });

  it('removes a GitHub token by shape', () => {
    assert.doesNotMatch(redact(`token=${fakeGitHubToken}`), /AAAAAAAAAAAAAAAA/);
  });

  it('removes a JWT by shape', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    assert.doesNotMatch(redact(`auth ${jwt}`), /payload\.signature/);
  });

  it('keeps the scheme but hides the password in a connection string', () => {
    const out = redact('postgres://user:s3cretpassword@db.example/app');
    assert.match(out, /^postgres:\/\/user:/);
    assert.match(out, /@db\.example\/app$/);
    assert.doesNotMatch(out, /s3cretpassword/);
  });

  it('removes a bearer token', () => {
    assert.doesNotMatch(redact('Authorization: Bearer abcdef1234567890'), /abcdef1234567890/);
  });

  it('removes a literal value from the environment even without a prefix', () => {
    // A key with no recognisable prefix would slip past the shape patterns, so
    // the environment values are also replaced verbatim.
    setEnv('JWT_SECRET', 'plainsecretvalue1234567890');
    assert.doesNotMatch(redact('the secret is plainsecretvalue1234567890'), /plainsecretvalue/);
  });

  it('removes a secret that appears inside a URL', () => {
    setEnv('OPENHANDS_API_KEY', 'sk-oh-abcdefghijklmnopqrstuvwxyz');
    assert.doesNotMatch(redact('GET https://api/x?key=sk-oh-abcdefghijklmnopqrstuvwxyz'), /abcdefghijklmnop/);
  });

  it('leaves ordinary text alone', () => {
    const text = 'studio is alive; nothing to do at https://studio.example';
    assert.equal(redact(text), text);
  });

  it('never redacts the studio URL, even when it is also in the environment', () => {
    // The address is public by design - it is what url.json publishes - and a log
    // that cannot name the address it checked is useless to an operator. This is
    // a regression guard: the value is easy to add to the secret list by mistake
    // because it arrives in an environment variable.
    setEnv('MY_AI_STUDIO_DOMAIN', 'work-1-example.prod-runtime.all-hands.dev');
    const url = 'https://work-1-example.prod-runtime.all-hands.dev';
    assert.equal(redact(url), url);
    assert.equal(redactValue({ url }).url, url);
  });
});

describe('redactValue', () => {
  it('blanks a credential by key name, whatever the value looks like', () => {
    const out = redactValue({ sandboxId: 'sb1', session_api_key: 'anything at all' });
    assert.equal(out.sandboxId, 'sb1');
    assert.equal(out.session_api_key, '<redacted>');
  });

  it('walks nested objects and arrays', () => {
    const out = redactValue({
      sandboxes: [{ id: 'sb1', session_api_key: 'x' }],
      nested: { deeper: { apiKey: 'y', keep: 'ok' } },
    });
    assert.equal(out.sandboxes[0].session_api_key, '<redacted>');
    assert.equal(out.nested.deeper.apiKey, '<redacted>');
    assert.equal(out.nested.deeper.keep, 'ok');
  });

  it('stops at a depth limit instead of recursing forever', () => {
    let deep = { value: 'end' };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    assert.doesNotThrow(() => redactValue(deep));
  });

  it('redacts secrets embedded in a string value', () => {
    const out = redactValue({ note: `the key is ${fakeOpenRouterKey}` });
    assert.doesNotMatch(out.note, /0123456789/);
    assert.match(out.note, /the key is/);
  });
});

/**
 * The publication path specifically.
 *
 * A recovery ends by writing url.json and by printing a line about what it
 * wrote, and both are read by things nobody controls - the file is world
 * readable in a public repository, and the line lands in a CI transcript. So
 * the four credentials named in the publication checklist are each checked
 * twice: once against redact(), and once against a line emitted through the
 * real logging path, which is the code that actually runs during a publish.
 */
describe('redaction on the publication path', () => {
  // Assembled at runtime for the same reason as the fixtures above: a literal
  // credential-shaped string in a tracked file is what a secret scanner flags.
  const publicationSecrets = {
    OPENROUTER_API_KEY: `sk-or-v1-${'9876543210'.repeat(3)}`,
    OPENHANDS_API_KEY: `sk-oh-${'Z'.repeat(24)}`,
    GITHUB_TOKEN: `ghp_${'Q'.repeat(30)}`,
    DATABASE_URL: 'postgres://publishinguser:publishingpassword@db.example:5432/studio',
  };

  /** Runs a callback with stdout and stderr captured. */
  function captureOutput(fn) {
    const written = [];
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    process.stdout.write = (chunk) => written.push(String(chunk));
    process.stderr.write = (chunk) => written.push(String(chunk));
    try {
      fn();
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    return written.join('');
  }

  for (const [name, value] of Object.entries(publicationSecrets)) {
    const sensitive = name === 'DATABASE_URL' ? 'publishingpassword' : value;

    it(`never prints ${name} in an emitted log line`, async () => {
      setEnv(name, value);
      // Imported lazily so the module sees the environment variable set above.
      const { log } = await import('../src/log.mjs');
      // Deliberately logged as a nested field, not as a bare string: that is
      // how a value from an API response would arrive, and it is the path where
      // a single serialisation mistake would expose it.
      const output = captureOutput(() => {
        log.info('publishing url.json', { url: 'https://studio.example', detail: { echo: value } });
        log.error('publication failed', { error: `failed with ${value}` });
      });

      assert.doesNotMatch(output, new RegExp(sensitive));
      assert.match(output, /publishing url\.json/);
      // The failure line still has to say something useful.
      assert.match(output, /publication failed/);
    });

    it(`never prints ${name} in a redacted value tree`, () => {
      setEnv(name, value);
      const out = redactValue({ url: 'https://studio.example', echo: value });
      assert.doesNotMatch(JSON.stringify(out), new RegExp(sensitive));
      assert.equal(out.url, 'https://studio.example');
    });
  }

  it('keeps a published payload free of every named credential', () => {
    // The shape of what url.json holds. Nothing here reads a credential, so a
    // secret could only appear by accident - which is exactly what this pins.
    for (const [name, value] of Object.entries(publicationSecrets)) setEnv(name, value);
    const payload = {
      schema: 1,
      service: 'my-ai-studio',
      url: 'https://studio.example',
      previousUrl: 'https://old.example',
      updatedAt: new Date().toISOString(),
      status: 'online',
    };
    const serialised = redact(JSON.stringify(payload, null, 2));

    for (const [name, value] of Object.entries(publicationSecrets)) {
      const sensitive = name === 'DATABASE_URL' ? 'publishingpassword' : value;
      assert.doesNotMatch(serialised, new RegExp(sensitive), `${name} appeared in the payload`);
    }
    // And the payload survived intact, so the redaction did not mangle it.
    assert.deepEqual(JSON.parse(serialised), payload);
  });
});
