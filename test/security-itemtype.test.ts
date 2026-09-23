import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateItemtype } from '../src/itemtype-security.js';

test('validateItemtype accepts valid GLPI itemtypes', () => {
  const validCases = [
    'Ticket',
    'Problem',
    'Change',
    'ITILCategory',
    'Computer',
    'Software',
    'Document_Item',
    'NetworkEquipment',
    'TicketTask',
    'glpi_users_123',
  ];

  for (const item of validCases) {
    assert.equal(validateItemtype(item), item);
  }
});

test('validateItemtype rejects path traversal and URL injection attempts', () => {
  const maliciousCases = [
    '../Ticket',
    'Ticket/../Problem',
    '../../etc/passwd',
    '..\\Windows\\System32',
    'Ticket/1',
    'Ticket?id=1',
    'Ticket#hash',
    'Ticket;rm -rf',
    'Ticket%2e%2e',
    'Ticket\0',
    'Ticket foo',
  ];

  for (const item of maliciousCases) {
    assert.throws(
      () => validateItemtype(item),
      /Invalid or disallowed itemtype/,
      `Expected "${item}" to be rejected`
    );
  }
});

test('validateItemtype rejects empty or non-string values', () => {
  assert.throws(() => validateItemtype(''), /non-empty string/);
  assert.throws(() => validateItemtype('   '), /Invalid or disallowed itemtype/);
  // @ts-expect-error test invalid type
  assert.throws(() => validateItemtype(null), /non-empty string/);
});
