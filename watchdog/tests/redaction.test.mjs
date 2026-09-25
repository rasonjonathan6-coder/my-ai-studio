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

afterEach(() => {
  for (const name of TOUCHED.splice(0)) delete process.env[name];
});

describe('redact', () => {
  it('removes an OpenRouter key by shape', () => {
    const key = 'sk-or-v1-abcdef1234567890abcdef1234567890';
    assert.doesNotMatch(redact(`provider said ${key}`), /abcdef1234567890/);
  });

  it('removes a GitHub token by shape', () => {
    const token = 'ghu_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    assert.doesNotMatch(redact(`token=${token}`), /AAAAAAAAAAAAAAAA/);
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
    const out = redactValue({ note: 'the key is sk-or-v1-abcdef1234567890abcdef' });
    assert.doesNotMatch(out.note, /abcdef1234567890/);
  });
});
