import type { Server } from 'node:http';
import { type Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { getRedis } from './redis.js';
import { SESSION_COOKIE, getSession, parseCookies } from './services/auth.js';
import { getMissedWorkspaceEvents, wsChannelForWorkspace } from './services/realtime.js';

interface ClientEntry {
  ws: WebSocket;
  workspace: string;
  lastSentSeq: number;
}

export interface WsManager {
  close: () => Promise<void>;
}

export function attachWebSocketServer(server: Server): WsManager {
  const wss = new WebSocketServer({ noServer: true });
  const sub: Redis = getRedis().duplicate();
  const clientsByChannel = new Map<string, Set<ClientEntry>>();
  let closed = false;

  sub.on('message', (channel: string, message: string) => {
    const clients = clientsByChannel.get(channel);
    if (!clients || clients.size === 0) return;

    let seq = 0;
    try {
      const parsed = JSON.parse(message) as { seq?: number };
      if (typeof parsed.seq === 'number') seq = parsed.seq;
    } catch {
      return;
    }

    for (const entry of clients) {
      if (entry.ws.readyState !== WebSocket.OPEN) continue;
      if (seq > 0 && seq <= entry.lastSentSeq) continue;
      if (seq > entry.lastSentSeq) entry.lastSentSeq = seq;
      entry.ws.send(message);
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const workspace = url.searchParams.get('workspace') ?? '';
      if (!workspace) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const cookies = parseCookies(req.headers.cookie);
      const user = await getSession(cookies[SESSION_COOKIE] ?? '');
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const isMember = user.workspaces.some((w) => w.id === workspace);
      if (!isMember) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const afterParam = url.searchParams.get('after');
      const afterSeq = afterParam !== null && /^\d+$/.test(afterParam) ? Number(afterParam) : null;

      wss.handleUpgrade(req, socket, head, async (ws) => {
        const channel = wsChannelForWorkspace(workspace);
        const entry: ClientEntry = {
          ws,
          workspace,
          lastSentSeq: afterSeq ?? 0,
        };

        let set = clientsByChannel.get(channel);
        if (!set) {
          set = new Set();
          clientsByChannel.set(channel, set);
          await sub.subscribe(channel);
        }
        set.add(entry);

        ws.on('close', () => {
          const chSet = clientsByChannel.get(channel);
          if (!chSet) return;
          chSet.delete(entry);
          if (chSet.size === 0) {
            clientsByChannel.delete(channel);
            if (!closed) {
              sub.unsubscribe(channel).catch(() => undefined);
            }
          }
        });

        if (afterSeq !== null) {
          try {
            const missed = await getMissedWorkspaceEvents(workspace, afterSeq);
            for (const frame of missed) {
              if (ws.readyState !== WebSocket.OPEN) break;
              const frameSeq = typeof frame.seq === 'number' ? frame.seq : 0;
              if (frameSeq > entry.lastSentSeq) {
                entry.lastSentSeq = frameSeq;
                ws.send(JSON.stringify(frame));
              }
            }
          } catch (err) {
            console.error('ws replay error:', err);
          }
        }
      });
    } catch {
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    }
  });

  return {
    close: async () => {
      closed = true;
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      await sub.quit().catch(() => undefined);
    },
  };
}
