import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { GlpiClient } from './glpi-client.js';

export interface SseServerOptions {
  port: number;
  host?: string;
  authToken?: string;
  handleJsonRpc?: (message: any) => Promise<any>;
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
  const { port, host = '0.0.0.0', authToken, handleJsonRpc } = options;
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
    const rawPath = parsedUrl.pathname;
    const pathname = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
    const remoteIp = req.socket.remoteAddress ?? 'unknown';

    console.error(`[HTTP] ${req.method} ${pathname} from ${remoteIp}`);

    // 1. Healthcheck endpoint for Easypanel / Traefik / Docker
    if (req.method === 'GET' && pathname === '/health') {
      const isGlpiConnected = !!client?.http?.session;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'mcp-glpi',
          version: '3.4.0',
          uptime: Math.floor(process.uptime()),
          activeSessions: transports.size,
          glpi: {
            url: client?.http?.config?.url ?? 'not-configured',
            connected: isGlpiConnected,
            sessionActive: isGlpiConnected,
          },
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // 2. Browser informational root page (only if browser explicitly requests HTML and path is /)
    const acceptHeader = req.headers.accept ?? '';
    if (req.method === 'GET' && pathname === '/' && acceptHeader.includes('text/html') && !acceptHeader.includes('text/event-stream')) {
      const isGlpiConnected = !!client?.http?.session;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          service: 'mcp-glpi',
          version: '3.4.0',
          status: 'running',
          transport: 'SSE',
          endpoints: {
            sse: '/sse',
            health: '/health',
            messages: '/messages',
          },
          glpi: {
            url: client?.http?.config?.url ?? 'not-configured',
            connected: isGlpiConnected,
          },
          info: 'Connect your MCP client to /sse (Server-Sent Events)',
        }, null, 2)
      );
      return;
    }

    // 3. Authentication check for MCP endpoints
    if (!isAuthorized(req, authToken)) {
      console.error(`[AUTH] 401 Unauthorized for ${req.method} ${pathname} from ${remoteIp}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing token.' }));
      return;
    }

    // 4. Establish SSE stream (GET /sse, GET /mcp or root GET /)
    if (req.method === 'GET' && (pathname === '/sse' || pathname === '/mcp' || pathname === '/')) {
      try {
        console.error(`[SSE] Establishing new SSE stream from ${remoteIp} (endpoint: ${pathname})`);
        const transport = new SSEServerTransport('/messages', res);
        const sessionId = transport.sessionId;
        transports.set(sessionId, transport);

        console.error(`[SSE] Session initialized: sessionId=${sessionId}`);

        const mcpServer = createServerInstance(client);

        transport.onclose = () => {
          console.error(`[SSE] Session closed: sessionId=${sessionId}`);
          transports.delete(sessionId);
          mcpServer.close().catch(() => {});
        };

        await mcpServer.connect(transport);
      } catch (err) {
        console.error('[SSE ERROR] Failed establishing stream:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to establish SSE stream' }));
        }
      }
      return;
    }

    // 5. Handling POST requests (SSE messages or direct JSON-RPC on any endpoint)
    if (req.method === 'POST') {
      const sessionId = parsedUrl.searchParams.get('sessionId') || (req.headers['mcp-session-id'] as string | undefined);

      // A. If an active SSE transport session is targeted, delegate to SSEServerTransport
      if (sessionId && transports.has(sessionId)) {
        console.error(`[SSE] POST ${pathname} forwarded to session=${sessionId}`);
        const transport = transports.get(sessionId)!;
        await transport.handlePostMessage(req, res);
        return;
      }

      // B. Direct JSON-RPC over HTTP POST (Stateless / Streamable MCP / Tool Discovery)
      try {
        let bodyStr = '';
        for await (const chunk of req) {
          bodyStr += chunk;
        }

        let body: any = null;
        if (bodyStr.trim()) {
          try {
            body = JSON.parse(bodyStr);
          } catch {
            console.error(`[HTTP] 400 Invalid JSON received in POST ${pathname} from ${remoteIp}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: Invalid JSON' } }));
            return;
          }
        }

        if (body && handleJsonRpc) {
          if (Array.isArray(body)) {
            // Batch JSON-RPC
            console.error(`[HTTP] Batch JSON-RPC request (${body.length} items) from ${remoteIp}`);
            const responses = await Promise.all(body.map((item) => handleJsonRpc(item)));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(responses.filter((r) => r !== null)));
            return;
          }

          console.error(`[HTTP] POST ${pathname} from ${remoteIp} -> JSON-RPC method '${body.method}'`);
          const response = await handleJsonRpc(body);
          if (response === null) {
            res.writeHead(202, { 'Content-Type': 'application/json' }).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }

        if (sessionId) {
          console.error(`[HTTP] 404 Session not found: ${sessionId}`);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Session not found: ${sessionId}` }));
          return;
        }

        console.error(`[HTTP] 404 Not Found: POST ${pathname} (no body or handler)`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Not found: POST ${pathname}` }));
      } catch (err) {
        console.error(`[HTTP ERROR] Processing POST ${pathname}:`, err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } }));
        }
      }
      return;
    }

    // 404 for unknown endpoints
    console.error(`[HTTP] 404 Not Found: ${req.method} ${pathname}`);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Not found: ${req.method} ${pathname}` }));
  });

  return {
    httpServer,
    start: () =>
      new Promise<void>((resolve) => {
        httpServer.listen(port, host, () => {
          console.error(
            `🚀 MCP GLPI Server listening on http://${host}:${port} (endpoints: /sse, /mcp, /health)`
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
