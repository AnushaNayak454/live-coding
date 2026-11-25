/**
 * WebSocket handler: /ws?workspace=<id>&after=<seq>
 * Authenticates via session cookie, validates workspace membership.
 * Supports event replay via after= parameter.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { getEventsAfter, type WsEvent } from './wsEvents.js';
import { getSubRedis } from './redis.js';

interface WsClient {
  ws: WebSocket;
  workspace: string;
  userId: string;
}

const clients: Set<WsClient> = new Set();

export function setupWebSocket(server: Server, sessionMiddleware: any): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    // Apply session middleware to get the session
    const fakeRes = {
      getHeader: () => undefined,
      setHeader: () => {},
      end: () => socket.destroy(),
    } as any;

    sessionMiddleware(req as any, fakeRes, async () => {
      try {
        const url = new URL(req.url ?? '', `http://localhost`);
        const workspace = url.searchParams.get('workspace');
        const after = url.searchParams.has('after')
          ? parseInt(url.searchParams.get('after')!, 10)
          : undefined;

        const user = (req as any).session?.user;

        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        const hasAccess = user.workspaces.some((w: any) => w.id === workspace);
        if (!workspace || !hasAccess) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, async (ws) => {
          const client: WsClient = { ws, workspace, userId: user.sub };
          clients.add(client);

          // Send replayed events if after= was specified
          if (after !== undefined) {
            try {
              const missed = await getEventsAfter(workspace, after);
              for (const event of missed) {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(event));
                }
              }
            } catch (err) {
              console.error('Replay error:', err);
            }
          }

          ws.on('close', () => {
            clients.delete(client);
          });

          ws.on('error', () => {
            clients.delete(client);
          });
        });
      } catch (err) {
        console.error('WebSocket upgrade error:', err);
        socket.destroy();
      }
    });
  });

  // Subscribe to Redis for cross-instance events
  subscribeToRedis();
}

function subscribeToRedis(): void {
  const sub = getSubRedis();

  sub.psubscribe('ws:*', (err) => {
    if (err) console.error('Redis psubscribe error:', err);
  });

  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    try {
      const event: WsEvent = JSON.parse(message);
      const workspace = channel.replace('ws:', '');
      broadcastToWorkspace(workspace, event);
    } catch (err) {
      console.error('Redis message parse error:', err);
    }
  });
}

function broadcastToWorkspace(workspace: string, event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.workspace === workspace && client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(payload);
      } catch (err) {
        // Client disconnected, ignore
      }
    }
  }
}
