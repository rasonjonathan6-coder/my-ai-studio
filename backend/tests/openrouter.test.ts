import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OpenRouterService } from '../src/services/openrouter.ts';
import { config } from '../src/config/index.ts';

/**
 * These tests exercise the OpenRouter client against a real local HTTP server,
 * so the status-code mapping, retry behaviour and secret redaction are verified
 * against actual socket traffic rather than a stubbed fetch.
 *
 * `config` is captured once at import time, so it is mutated in place here.
 */
type Responder = (req: http.IncomingMessage, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl = '';
let respond: Responder;
let requestCount = 0;
let lastAuthHeader: string | undefined;

before(async () => {
  server = http.createServer((req, res) => {
    requestCount += 1;
    lastAuthHeader = req.headers.authorization;
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  config.openRouterBaseUrl = baseUrl;
  config.openRouterApiKey = 'test-key-not-a-real-secret';
  config.openRouterMaxRetries = 0;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function reset(responder: Responder): OpenRouterService {
  respond = responder;
  requestCount = 0;
  return new OpenRouterService();
}

test('returns content and usage from a real completion response', async () => {
  const svc = reset((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'test/model',
      choices: [{ message: { content: 'hello from the model' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
  });

  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.content, 'hello from the model');
  assert.equal(out.usage.totalTokens, 18);
});

test('sends the API key as a bearer token and never in the body', async () => {
  let seenBody = '';
  const svc = reset((req, res) => {
    req.on('data', (c) => { seenBody += c.toString(); });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });

  await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(lastAuthHeader, 'Bearer test-key-not-a-real-secret');
  assert.ok(!seenBody.includes('test-key-not-a-real-secret'), 'the key must not appear in the request body');
});

test('maps 429 to a retryable rate_limited failure', async () => {
  const svc = reset((_req, res) => { res.writeHead(429); res.end('slow down'); });
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'rate_limited');
  assert.equal(out.retryable, true);
});

test('maps 404 to a non-retryable model_unavailable failure', async () => {
  const svc = reset((_req, res) => { res.writeHead(404); res.end('no such model'); });
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'model_unavailable');
  assert.equal(out.retryable, false);
});

test('maps 500 to a retryable http_error failure', async () => {
  const svc = reset((_req, res) => { res.writeHead(500); res.end('boom'); });
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'http_error');
  assert.equal(out.retryable, true);
});

test('rejects a non-JSON body as invalid_response', async () => {
  const svc = reset((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('this is not json');
  });
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'invalid_response');
});

test('rejects a JSON body with no completion text as invalid_response', async () => {
  const svc = reset((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
  });
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'invalid_response');
});

test('a timeout is reported as retryable without hanging', async () => {
  const svc = reset(() => { /* never respond: the client must time out */ });
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 300 });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'timeout');
  assert.equal(out.retryable, true);
});

test('retries a retryable failure up to the configured maximum', async () => {
  config.openRouterMaxRetries = 2;
  const svc = reset((_req, res) => { res.writeHead(503); res.end('unavailable'); });
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  config.openRouterMaxRetries = 0;
  assert.equal(out.ok, false);
  assert.equal(requestCount, 3, 'initial attempt plus two retries');
});

test('a network error is reported without leaking the API key', async () => {
  config.openRouterBaseUrl = 'http://127.0.0.1:1';
  const svc = new OpenRouterService();
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }], timeoutMs: 500 });
  config.openRouterBaseUrl = baseUrl;
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.ok(!out.message.includes('test-key-not-a-real-secret'), 'failure message must not contain the key');
});

test('reports not_configured when the key is absent', async () => {
  config.openRouterApiKey = '';
  const svc = new OpenRouterService();
  const out = await svc.chat({ messages: [{ role: 'user', content: 'hi' }] });
  config.openRouterApiKey = 'test-key-not-a-real-secret';
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.kind, 'not_configured');
});

test('status() never exposes the API key value', () => {
  const svc = new OpenRouterService();
  const status = svc.status();
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes('test-key-not-a-real-secret'));
});
