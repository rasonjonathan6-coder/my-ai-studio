import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, downloadUrl, websocketUrl } from './client.ts';

/**
 * These tests drive the real request() path with a stubbed fetch. Only the
 * network boundary is faked: URL construction, header handling, JSON parsing
 * and error mapping all run as they do in the browser.
 */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
  return calls;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('sends credentials and a JSON content-type only when there is a body', async () => {
    const calls = stubFetch(() => jsonResponse({ user: { id: 'u1' } }));

    await api.me();
    expect(calls[0].url).toContain('/api/auth/me');
    expect(calls[0].init.credentials).toBe('include');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();

    await api.login('a@b.c', 'password123');
    expect(calls[1].init.method).toBe('POST');
    expect((calls[1].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ email: 'a@b.c', password: 'password123' });
  });

  it('turns a structured error body into an ApiError with status and code', async () => {
    stubFetch(() => jsonResponse({ error: 'path traversal rejected', code: 'invalid_path' }, 400));
    await expect(api.readFile('p1', '../../etc/passwd')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'invalid_path',
      message: 'path traversal rejected',
    });
  });

  it('falls back to a generic code when the error body is not JSON', async () => {
    stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    const err = await api.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).code).toBe('http_error');
  });

  it('returns null for an empty 200 body instead of throwing', async () => {
    stubFetch(() => new Response('', { status: 200 }));
    await expect(api.logout()).resolves.toBeNull();
  });

  it('url-encodes file paths so traversal-looking input cannot reshape the URL', async () => {
    const calls = stubFetch(() => jsonResponse({ path: 'a', content: '', size: 0 }));
    await api.readFile('p1', '../secret.env');
    expect(calls[0].url).toContain('path=..%2Fsecret.env');
    expect(calls[0].url).not.toContain('../secret.env');
  });

  it('builds download URLs without ever embedding a credential', () => {
    const url = downloadUrl('proj-1', 'apk');
    expect(url).toBe('/api/projects/proj-1/download/apk');
    expect(url).not.toMatch(/sk-or|key=|token=/i);
  });

  it('derives the websocket scheme from the page origin', () => {
    expect(websocketUrl('p1')).toMatch(/^wss?:\/\/[^/]+\/ws\?projectId=p1$/);
  });
});
