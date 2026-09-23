import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHttpSseServer } from '../src/sse-server.js';
import { GlpiClient } from '../src/glpi-client.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

test('SSE Server exposes /health endpoint without requiring auth', async () => {
  const dummyClient = {} as unknown as GlpiClient;
  const dummyFactory = () =>
    new Server({ name: 'test', version: '1.0' }, { capabilities: {} });

  const sseServer = createHttpSseServer(dummyClient, dummyFactory, {
    port: 0, // dynamic port
    authToken: 'supersecret',
  });

  await sseServer.start();
  const address = sseServer.httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server address not resolved');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { status: string; service: string };
    assert.equal(data.status, 'ok');
    assert.equal(data.service, 'mcp-glpi');
  } finally {
    await sseServer.close();
  }
});

test('SSE Server enforces authToken on /sse when configured', async () => {
  const dummyClient = {} as unknown as GlpiClient;
  const dummyFactory = () =>
    new Server({ name: 'test', version: '1.0' }, { capabilities: {} });

  const sseServer = createHttpSseServer(dummyClient, dummyFactory, {
    port: 0,
    authToken: 'supersecret',
  });

  await sseServer.start();
  const address = sseServer.httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server address not resolved');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Missing token -> 401
    const unauthRes = await fetch(`${baseUrl}/sse`);
    assert.equal(unauthRes.status, 401);

    // 2. Wrong token -> 401
    const wrongRes = await fetch(`${baseUrl}/sse`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    assert.equal(wrongRes.status, 401);
  } finally {
    await sseServer.close();
  }
});
