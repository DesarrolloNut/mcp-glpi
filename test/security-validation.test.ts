import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ticketCreateSchema,
  ticketDeleteSchema,
  ticketAssignSchema,
  setValidationStatusSchema,
  uploadDocumentSchema,
} from '../src/schemas.js';

test('ticketCreateSchema validates required fields and types', () => {
  const valid = {
    name: 'Hardware issue',
    content: 'Printer is offline',
    urgency: 3,
  };
  const parsed = ticketCreateSchema.parse(valid);
  assert.equal(parsed.name, 'Hardware issue');

  assert.throws(() => ticketCreateSchema.parse({ name: '' }), /at least 1 character/);
  assert.throws(() => ticketCreateSchema.parse({ name: 'test', content: 'test', urgency: 10 }), /Number must be less than or equal to 5/);
});

test('ticketDeleteSchema defaults force to false', () => {
  const parsed = ticketDeleteSchema.parse({ id: 42 });
  assert.equal(parsed.id, 42);
  assert.equal(parsed.force, false);

  assert.throws(() => ticketDeleteSchema.parse({ id: -1 }), /Number must be greater than 0/);
});

test('ticketAssignSchema requires user_id or group_id', () => {
  assert.ok(ticketAssignSchema.parse({ ticket_id: 1, user_id: 5 }));
  assert.ok(ticketAssignSchema.parse({ ticket_id: 1, group_id: 10 }));

  assert.throws(
    () => ticketAssignSchema.parse({ ticket_id: 1 }),
    /user_id or group_id required/
  );
});

test('setValidationStatusSchema only allows status 2 (Granted) or 3 (Refused)', () => {
  assert.ok(setValidationStatusSchema.parse({ validation_id: 10, status: 2 }));
  assert.ok(setValidationStatusSchema.parse({ validation_id: 10, status: 3 }));

  assert.throws(
    () => setValidationStatusSchema.parse({ validation_id: 10, status: 1 }),
    /Invalid literal value/
  );
});

test('uploadDocumentSchema requires non-empty file_path', () => {
  assert.ok(uploadDocumentSchema.parse({ file_path: 'report.pdf' }));
  assert.throws(
    () => uploadDocumentSchema.parse({ file_path: '' }),
    /file_path required/
  );
});
