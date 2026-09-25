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
