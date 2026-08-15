import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing } from '../lib/useAgentSearch';

test('parses SSE data records with either line-ending style', () => {
  assert.deepEqual(__testing.parseSseRecord('event: message\r\ndata: {"type":"status","message":"Hi"}'), {
    type: 'status',
    message: 'Hi',
  });
  assert.deepEqual(__testing.parseSseRecord('data: {"type":"error","message":"No"}'), {
    type: 'error',
    message: 'No',
  });
});

test('ignores incomplete or malformed SSE records', () => {
  assert.equal(__testing.parseSseRecord('event: message'), null);
  assert.equal(__testing.parseSseRecord('data: {not-json}'), null);
});

test('accepts legal data fields without a space and joins multiple data lines', () => {
  assert.deepEqual(
    __testing.parseSseRecord('data:{"type":"error",\ndata:"message":"No"}'),
    { type: 'error', message: 'No' }
  );
});

test('terminal errors clear status and finish pending retailer progress', () => {
  const state = {
    running: true,
    status: 'Checking prices…',
    query: null,
    storeCount: 2,
    domainCount: 2,
    progress: [
      { domain: 'one.kz', state: 'start' as const },
      { domain: 'two.kz', state: 'done' as const, found: 1, failure: null },
    ],
    deals: null,
    summary: null,
    error: null,
  };

  const failed = __testing.reduce(state, {
    type: 'error',
    message: 'The search reached its time limit.',
  });
  assert.equal(failed.running, false);
  assert.equal(failed.status, null);
  assert.equal(failed.progress[0].state, 'done');
  assert.equal(failed.progress[0].failure, 'timeout');
  assert.equal(failed.progress[1].found, 1);
});
