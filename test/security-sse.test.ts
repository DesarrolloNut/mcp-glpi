import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHttpSseServer } from '../src/sse-server.js';
import { GlpiClient } from '../src/glpi-client.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { handleJsonRpcMessage } from '../src/index.js';

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

test('HTTP POST handles direct JSON-RPC tools/list and initialize requests', async () => {
  const dummyClient = {} as unknown as GlpiClient;
  const dummyFactory = () =>
    new Server({ name: 'test', version: '1.0' }, { capabilities: {} });

  const sseServer = createHttpSseServer(dummyClient, dummyFactory, {
    port: 0,
    handleJsonRpc: (msg) => handleJsonRpcMessage(dummyClient, msg),
  });

  await sseServer.start();
  const address = sseServer.httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Server address not resolved');
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. POST / with tools/list
    const toolsRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });

    assert.equal(toolsRes.status, 200);
    const toolsData = (await toolsRes.json()) as any;
    assert.equal(toolsData.jsonrpc, '2.0');
    assert.equal(toolsData.id, 1);
    assert.ok(Array.isArray(toolsData.result?.tools));
    assert.equal(toolsData.result.tools.length, 85);

    // 2. POST / with initialize
    const initRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {},
      }),
    });

    assert.equal(initRes.status, 200);
    const initData = (await initRes.json()) as any;
    assert.equal(initData.jsonrpc, '2.0');
    assert.equal(initData.result?.serverInfo?.name, 'mcp-glpi');
  } finally {
    await sseServer.close();
  }
});
