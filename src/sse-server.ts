import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { GlpiClient } from './glpi-client.js';

export interface SseServerOptions {
  port: number;
  host?: string;
  authToken?: string;
}

/**
 * Validates authentication token from Authorization header (Bearer) or ?token query param.
 */
function isAuthorized(req: IncomingMessage, authToken?: string): boolean {
  if (!authToken) return true; // Authentication not configured

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === authToken) return true;
  }

  // Fallback for SSE clients that cannot set custom headers
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken && queryToken === authToken) return true;

  return false;
}

export function createHttpSseServer(
  client: GlpiClient,
  createServerInstance: (client: GlpiClient) => Server,
  options: SseServerOptions
) {
  const { port, host = '0.0.0.0', authToken } = options;
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Add CORS headers for web-based MCP clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const hostHeader = req.headers.host ?? 'localhost';
    const parsedUrl = new URL(req.url ?? '/', `http://${hostHeader}`);
    const pathname = parsedUrl.pathname;

    // 1. Healthcheck endpoint for Easypanel / Traefik / Docker
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'mcp-glpi',
          uptime: Math.floor(process.uptime()),
          activeSessions: transports.size,
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // 2. Authentication check for MCP endpoints
    if (!isAuthorized(req, authToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token.' }));
      return;
    }

    // 3. Establish SSE stream (GET /sse or GET /mcp)
    if (req.method === 'GET' && (pathname === '/sse' || pathname === '/mcp')) {
      try {
        const transport = new SSEServerTransport('/messages', res);
        const sessionId = transport.sessionId;
        transports.set(sessionId, transport);

        const mcpServer = createServerInstance(client);

        transport.onclose = () => {
          transports.delete(sessionId);
          mcpServer.close().catch(() => {});
        };

        await mcpServer.connect(transport);
      } catch (err) {
        console.error('Error establishing SSE stream:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to establish SSE stream' }));
        }
      }
      return;
    }

    // 4. Client messages endpoint (POST /messages)
    if (req.method === 'POST' && pathname === '/messages') {
      const sessionId = parsedUrl.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing sessionId query parameter' }));
        return;
      }

      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Not found: ${req.method} ${pathname}` }));
  });

  return {
    httpServer,
    start: () =>
      new Promise<void>((resolve) => {
        httpServer.listen(port, host, () => {
          console.error(
            `MCP GLPI Server running over HTTP/SSE on http://${host}:${port} (endpoints: /sse, /mcp, /health)`
          );
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const transport of transports.values()) {
          transport.close().catch(() => {});
        }
        transports.clear();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
