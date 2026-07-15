/**
 * Tests for document upload (multipart POST /Document).
 *
 * Run with: npm test
 *
 * These tests verify:
 *   - form option sends FormData without a JSON Content-Type (fetch sets the boundary)
 *   - uploadDocument builds the GLPI uploadManifest + filename[0] pair
 *   - the file part and the manifest `_filename` entry carry the same name
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiHttp } from '../src/http.js';
import { GlpiClient } from '../src/glpi-client.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler) {
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(handler);
}

test('form option sends FormData body without JSON Content-Type', async () => {
  let capturedInit: RequestInit | undefined;

  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedInit = init;
    return new Response(JSON.stringify({ id: 7 }), { status: 200 });
  });

  const http = new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
  await http.initSession();

  const form = new FormData();
  form.append('field', 'value');
  await http.request('Document', { method: 'POST', form });

  assert.ok(capturedInit, 'request should have been sent');
  assert.ok(capturedInit.body instanceof FormData, 'body should be the FormData');
  const headers = capturedInit.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], undefined, 'Content-Type must be left to fetch');
  assert.equal(headers['Session-Token'], 's');
});

test('uploadDocument builds manifest + file pair and returns the document id', async () => {
  let capturedUrl = '';
  let capturedBody: FormData | undefined;

  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedUrl = url;
    capturedBody = init?.body as FormData;
    return new Response(JSON.stringify({ id: 321, message: 'Document added' }), { status: 201 });
  });

  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  const result = await client.uploadDocument({
    filename: 'screenshot.png',
    data: new Uint8Array([137, 80, 78, 71]),
    name: 'Pantalla de error',
    mimeType: 'image/png',
  });

  assert.equal(result.id, 321);
  assert.match(capturedUrl, /\/apirest\.php\/Document$/);
  assert.ok(capturedBody instanceof FormData);

  const manifestPart = capturedBody.get('uploadManifest');
  assert.equal(typeof manifestPart, 'string', 'uploadManifest must be a plain field (not a file part)');
  const manifest = JSON.parse(manifestPart as string);
  assert.deepEqual(manifest, {
    input: { name: 'Pantalla de error', _filename: ['screenshot.png'] },
  });

  const filePart = capturedBody.get('filename[0]');
  assert.ok(filePart instanceof File, 'filename[0] should carry the file');
  assert.equal(filePart.name, 'screenshot.png', 'file part name must match _filename');
  assert.equal(filePart.type, 'image/png');
  assert.equal(filePart.size, 4);
});

test('uploadDocument links to an item via the manifest when itemtype/items_id are set', async () => {
  let capturedBody: FormData | undefined;

  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedBody = init?.body as FormData;
    return new Response(JSON.stringify({ id: 9 }), { status: 201 });
  });

  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  await client.uploadDocument({
    filename: 'shot.png',
    data: new Uint8Array([1]),
    itemtype: 'Ticket',
    items_id: 20642,
  });

  const manifest = JSON.parse(capturedBody!.get('uploadManifest') as string);
  assert.equal(manifest.input.itemtype, 'Ticket');
  assert.equal(manifest.input.items_id, 20642);
});

test('uploadDocument defaults the document name to the filename', async () => {
  let capturedBody: FormData | undefined;

  installFetch(async (url, init) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedBody = init?.body as FormData;
    return new Response(JSON.stringify({ id: 5 }), { status: 201 });
  });

  const client = new GlpiClient({ url: 'https://glpi.test', userToken: 'u' });
  await client.uploadDocument({ filename: 'error.log', data: new Uint8Array([65]) });

  const manifest = JSON.parse(capturedBody!.get('uploadManifest') as string);
  assert.equal(manifest.input.name, 'error.log');
  assert.deepEqual(manifest.input._filename, ['error.log']);
});
