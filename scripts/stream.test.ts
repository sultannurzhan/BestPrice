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
