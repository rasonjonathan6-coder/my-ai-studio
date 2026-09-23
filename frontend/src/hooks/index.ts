import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, websocketUrl } from '../api/client.ts';
import type { Project, User, WsEvent } from '../api/types.ts';

/** Session state. The session lives in an httpOnly cookie set by the backend. */
export function useSession() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.me()
      .then((res) => { if (!cancelled) setUser(res.user); })
      .catch(() => { if (!cancelled) setUser(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setUser(res.user);
    return res.user;
  }, []);

  const register = useCallback(async (email: string, password: string, displayName?: string) => {
    const res = await api.register(email, password, displayName);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, []);

  return { user, loading, login, register, logout, setUser };
}

export function useAsyncAction<Args extends unknown[], R>(
  action: (...args: Args) => Promise<R>,
): { run: (...args: Args) => Promise<R | null>; pending: boolean; error: string | null; reset: () => void } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (...args: Args): Promise<R | null> => {
    setPending(true);
    setError(null);
    try {
      return await action(...args);
    } catch (err) {
      const message = err instanceof ApiError
        ? `${err.message}${err.code ? ` (${err.code})` : ''}`
        : err instanceof Error ? err.message : String(err);
      setError(message);
      return null;
    } finally {
      setPending(false);
    }
  }, [action]);

  return { run, pending, error, reset: () => setError(null) };
}

/**
 * Subscribes to real project events. Reconnects with backoff while the tab is
 * open. Events are handed to the caller; nothing is synthesised locally.
 */
export function useProjectSocket(projectId: string | null, onEvent: (event: WsEvent) => void) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!projectId) return undefined;
    let ws: WebSocket | null = null;
    let attempt = 0;
    let closed = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(websocketUrl(projectId));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        setError(null);
      };
      ws.onmessage = (event) => {
        try {
          handlerRef.current(JSON.parse(event.data as string) as WsEvent);
        } catch {
          // A malformed frame must not break the stream.
        }
      };
      ws.onerror = () => setError('websocket error');
      ws.onclose = (ev) => {
        setConnected(false);
        if (closed) return;
        if (ev.code === 4401 || ev.code === 4403) {
          setError(ev.code === 4401 ? 'session expired' : 'not authorised for this project');
          return;
        }
        attempt += 1;
        const delay = Math.min(1000 * 2 ** attempt, 15000);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [projectId]);

  return { connected, error };
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listProjects();
      setProjects(res.projects);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return { projects, loading, error, refresh, setProjects };
}
