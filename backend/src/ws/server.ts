/**
 * WebSocket endpoint. Clients subscribe per project over the same event bus the
 * agent, terminal and build services publish to, so what the UI shows is what
 * the backend actually did.
 */
import type { Server, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config/index.ts';
import { logger } from '../lib/logger.ts';
import { verifySession } from '../services/auth.ts';
import { findUserById } from '../services/auth.ts';
import { getProjectForOwner, isUuid } from '../services/projects.ts';
import { eventBus } from '../services/eventBus.ts';

interface ClientState {
  userId: string;
  projectId: string;
  unsubscribe: () => void;
  alive: boolean;
}

export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Map<WebSocket, ClientState>();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = extractTokenFromRequest(req, url);
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const decoded = verifySession(token);
    if (!decoded) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const projectId = url.searchParams.get('projectId') ?? '';
    if (!isUuid(projectId)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      void authorizeAndAttach(ws, decoded.userId, projectId, clients);
    });
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  return wss;
}

async function authorizeAndAttach(
  ws: WebSocket,
  userId: string,
  projectId: string,
  clients: Map<WebSocket, ClientState>,
): Promise<void> {
  try {
    const user = await findUserById(userId);
    if (!user) {
      ws.close(4401, 'unauthenticated');
      return;
    }
    const project = await getProjectForOwner(projectId, userId);
    if (!project) {
      ws.close(4403, 'forbidden');
      return;
    }

    const unsubscribe = eventBus.subscribe(projectId, (event) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    });

    const state: ClientState = { userId, projectId, unsubscribe, alive: true };
    clients.set(ws, state);

    ws.on('pong', () => {
      state.alive = true;
    });
    ws.on('message', (raw: Buffer) => {
      // Clients may only ping; command execution goes through authenticated HTTP.
      let parsed: { type?: string } = {};
      try {
        parsed = JSON.parse(raw.toString('utf8')) as { type?: string };
      } catch {
        return;
      }
      if (parsed.type === 'ping' && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pong', projectId, timestamp: new Date().toISOString() }));
      }
    });
    ws.on('close', () => {
      unsubscribe();
      clients.delete(ws);
    });
    ws.on('error', () => {
      unsubscribe();
      clients.delete(ws);
    });

    ws.send(JSON.stringify({
      type: 'connected',
      projectId,
      timestamp: new Date().toISOString(),
      message: `subscribed to project events (sandbox=${config.sandbox.enabled})`,
    }));
    logger.info('websocket client attached', { userId, projectId });
  } catch (err) {
    logger.error('websocket authorization failed', { error: err instanceof Error ? err.message : String(err) });
    ws.close(4500, 'internal error');
  }
}

function extractTokenFromRequest(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const queryToken = url.searchParams.get('token');
  if (queryToken) return queryToken;
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === config.sessionCookieName) return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}
