/**
 * A small client for the OpenHands app-server and agent-server APIs.
 *
 * Only the calls the watchdog actually makes are implemented, and every one was
 * exercised against the live API before being written down here:
 *
 *   GET    /api/v1/users/me                      validate the credential
 *   GET    /api/v1/sandboxes/search              find a sandbox and its URLs
 *   POST   /api/v1/sandboxes                     start a new sandbox
 *   DELETE /api/v1/sandboxes/{id}?sandbox_id=…   discard one
 *   POST   {agent_server_url}/api/bash/execute_bash_command
 *
 * Two details of this API are easy to get wrong and cost real time to rediscover:
 * the delete endpoint wants the id in both the path and a query parameter, and a
 * new sandbox reports an empty `exposed_urls` until its status reaches RUNNING.
 *
 * Credentials are read from the environment and never logged; the client sends
 * the session key only to the sandbox that issued it.
 */

import { log } from './log.mjs';

export const APP_SERVER = process.env.OPENHANDS_BASE_URL || 'https://app.all-hands.dev';

export const WORKER_PORTS = { WORKER_1: 12000, WORKER_2: 12001 };

export class ApiError extends Error {
  constructor(message, { status, detail } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

export function readCredential() {
  const key = process.env.OPENHANDS_CLOUD_API_KEY || process.env.OPENHANDS_API_KEY;
  if (!key) {
    throw new ApiError(
      'no OpenHands credential: set OPENHANDS_CLOUD_API_KEY or OPENHANDS_API_KEY',
    );
  }
  return key;
}

export class OpenHandsClient {
  constructor({ baseUrl = APP_SERVER, credential = readCredential(), timeoutMs = 30_000, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.credential = credential;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, headers = {}, timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.credential}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.slice(0, 500) };
        }
      }
      if (!res.ok) {
        throw new ApiError(`${method} ${path} failed with HTTP ${res.status}`, {
          status: res.status,
          detail: parsed,
        });
      }
      return parsed;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(`${method} ${path} failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Confirms the credential works before any sandbox is created. */
  async whoAmI() {
    return this.request('/api/v1/users/me');
  }

  async listSandboxes(limit = 20) {
    const page = await this.request(`/api/v1/sandboxes/search?limit=${limit}`);
    return Array.isArray(page?.items) ? page.items : [];
  }

  async getSandbox(id) {
    const items = await this.listSandboxes(50);
    return items.find((item) => item.id === id) ?? null;
  }

  /**
   * Starts a sandbox and waits for it to be usable. `exposed_urls` is empty
   * while the status is STARTING, so the URLs are only meaningful once the
   * sandbox reaches RUNNING.
   */
  async startSandbox({ pollIntervalMs = 5_000, timeoutMs = 300_000, onPoll } = {}) {
    const created = await this.request('/api/v1/sandboxes', { method: 'POST' });
    const id = created?.id;
    if (!id) throw new ApiError('sandbox creation returned no id', { detail: created });
    log.info('sandbox created', { sandboxId: id, status: created.status });

    const deadline = Date.now() + timeoutMs;
    let last = created;
    while (Date.now() < deadline) {
      last = (await this.getSandbox(id)) ?? last;
      if (onPoll) onPoll(last);
      if (last.status === 'RUNNING') return last;
      if (last.status === 'ERROR') {
        throw new ApiError(`sandbox ${id} entered ERROR`, { detail: last.status_detail });
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new ApiError(`sandbox ${id} did not reach RUNNING within ${timeoutMs}ms`, {
      detail: last?.status,
    });
  }

  async deleteSandbox(id) {
    // The endpoint requires the id in the path and as a query parameter.
    return this.request(`/api/v1/sandboxes/${encodeURIComponent(id)}?sandbox_id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /** Returns the public URL exposing `port`, or null when it is not exposed. */
  static urlForPort(sandbox, port) {
    const match = (sandbox?.exposed_urls ?? []).find((entry) => entry.port === port);
    return match ? match.url.replace(/\/+$/, '') : null;
  }

  /** The agent server URL used to run commands inside a sandbox. */
  static agentServerUrl(sandbox) {
    return OpenHandsClient.urlForPort(sandbox, 60000);
  }
}

/** Runs a shell command inside a sandbox via its agent server. */
export class SandboxShell {
  constructor({ agentServerUrl, sessionApiKey, timeoutMs = 120_000, fetchImpl = fetch }) {
    if (!agentServerUrl) throw new ApiError('sandbox has no agent server URL');
    if (!sessionApiKey) throw new ApiError('sandbox has no session API key');
    this.agentServerUrl = agentServerUrl.replace(/\/+$/, '');
    this.sessionApiKey = sessionApiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async run(command, { timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.agentServerUrl}/api/bash/execute_bash_command`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'X-Session-API-Key': this.sessionApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ command }),
      });
      if (!res.ok) {
        throw new ApiError(`command failed with HTTP ${res.status}`, { status: res.status });
      }
      const body = await res.json();
      return {
        exitCode: typeof body.exit_code === 'number' ? body.exit_code : null,
        stdout: typeof body.stdout === 'string' ? body.stdout : '',
        stderr: typeof body.stderr === 'string' ? body.stderr : '',
      };
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(`command could not run: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs a command and throws when it exits non-zero. */
  async runChecked(command, options) {
    const result = await this.run(command, options);
    if (result.exitCode !== 0) {
      throw new ApiError(`command exited ${result.exitCode}`, {
        detail: { command, stderr: result.stderr.slice(0, 800), stdout: result.stdout.slice(0, 400) },
      });
    }
    return result;
  }
}

export { log };
