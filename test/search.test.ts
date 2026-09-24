/**
 * Tests for GlpiSearch (range building) and SearchOptionsCache (field
 * resolution on a localized instance).
 *
 * Regression coverage for two bugs found against a live GLPI 11 (French):
 *   - search() passed `limit` as the range END: limit 5 -> "0-5" -> 6 rows.
 *   - resolveField() only matched localized labels ("Statut"), never the
 *     locale-independent column name ("status") or canonical uid.
 */

import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import { GlpiHttp } from '../src/http.js';
import { GlpiSearch } from '../src/search.js';
import { SearchOptionsCache } from '../src/search-options.js';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function installFetch(handler: FetchHandler) {
  // @ts-expect-error overriding global fetch
  global.fetch = mock.fn(handler);
}

function authedHttp(): GlpiHttp {
  return new GlpiHttp({ url: 'https://glpi.test', userToken: 'u' });
}

test('search() builds an inclusive range: limit 5 -> range=0-4', async () => {
  let capturedRange = '';
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedRange = new URL(url).searchParams.get('range') ?? '';
    return new Response(JSON.stringify({ totalcount: 100, count: 5, data: [1, 2, 3, 4, 5] }), { status: 200 });
  });

  const search = new GlpiSearch(authedHttp());
  await search.search('Ticket', { limit: 5 });
  assert.equal(capturedRange, '0-4');

  await search.search('Ticket', { start: 10, limit: 20 });
  assert.equal(capturedRange, '10-29');
});

test('count() probes with range=0-0 and returns totalcount', async () => {
  let capturedRange = '';
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    capturedRange = new URL(url).searchParams.get('range') ?? '';
    return new Response(JSON.stringify({ totalcount: 1803, count: 1, data: [{}] }), { status: 200 });
  });

  const search = new GlpiSearch(authedHttp());
  const n = await search.count('Ticket');
  assert.equal(n, 1803);
  assert.equal(capturedRange, '0-0');
});

// Catalogue shaped like a real GLPI 11 French instance (labels localized,
// field/uid locale-independent, "name" column duplicated via joined tables).
const FRENCH_TICKET_OPTIONS = {
  '1': { name: 'Titre', table: 'glpi_tickets', field: 'name', uid: 'Ticket.name', datatype: 'itemlink' },
  '2': { name: 'ID', table: 'glpi_tickets', field: 'id', uid: 'Ticket.id', datatype: 'number' },
  '4': { name: 'Demandeur', table: 'glpi_users', field: 'name', uid: 'Ticket.Ticket_User.User.name', datatype: 'dropdown' },
  '12': { name: 'Statut', table: 'glpi_tickets', field: 'status', uid: 'Ticket.status', datatype: 'specific' },
  common: 'metadata entry to be skipped',
};

function installCatalogueFetch() {
  installFetch(async (url) => {
    if (url.endsWith('/initSession')) {
      return new Response(JSON.stringify({ session_token: 's' }), { status: 200 });
    }
    assert.match(url, /listSearchOptions\/Ticket/);
    return new Response(JSON.stringify(FRENCH_TICKET_OPTIONS), { status: 200 });
  });
}

test('resolveField works on a localized (French) instance', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  // Locale-independent column name — the case that failed live.
  assert.equal(await cache.resolveField('Ticket', 'status'), 12);
  // Localized label still works.
  assert.equal(await cache.resolveField('Ticket', 'Statut'), 12);
  // Explicit uid.
  assert.equal(await cache.resolveField('Ticket', 'Ticket.status'), 12);
  // Numeric passthrough.
  assert.equal(await cache.resolveField('Ticket', 12), 12);
  assert.equal(await cache.resolveField('Ticket', '12'), 12);
  // Unknown stays undefined.
  assert.equal(await cache.resolveField('Ticket', 'does_not_exist'), undefined);
});

test('resolveField prefers the own-table option on column-name collisions', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  // "name" exists on glpi_tickets (id 1, canonical uid Ticket.name) AND on
  // glpi_users via the requester join (id 4). The own-table one must win.
  assert.equal(await cache.resolveField('Ticket', 'name'), 1);
});

test('normalizeRow translates numeric search option IDs to canonical field names', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  const rawRow = {
    '1': 'Imprimante en panne',
    '2': 42,
    '12': 'Nouveau',
    '4': 'Jean Dupont',
    custom_field: 'unaltered',
  };

  const normalized = await cache.normalizeRow('Ticket', rawRow);

  assert.deepEqual(normalized, {
    name: 'Imprimante en panne',
    id: 42,
    status: 'Nouveau',
    demandeur: 'Jean Dupont',
    custom_field: 'unaltered',
  });
});

test('normalizeRows translates an array of search result rows', async () => {
  installCatalogueFetch();
  const cache = new SearchOptionsCache(authedHttp());

  const rows = [
    { '1': 'Panne réseau', '2': 101, '12': 'En cours' },
    { '1': 'Demande écran', '2': 102, '12': 'Résolu' },
  ];

  const normalized = await cache.normalizeRows('Ticket', rows);

  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0], { name: 'Panne réseau', id: 101, status: 'En cours' });
  assert.deepEqual(normalized[1], { name: 'Demande écran', id: 102, status: 'Résolu' });
});
