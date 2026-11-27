import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextAutomationTimes } from '@alpacawork/backend/test-dist/automations/schedule.js';

test('the shared cron parser accounts for missing and repeated local hours', () => {
  const times = (pattern: string, after: string, count = 2) =>
    nextAutomationTimes(pattern, 'America/New_York', new Date(after), count);
  assert.deepEqual(times('30 2 * * *', '2026-03-08T05:00:00Z'),
    ['2026-03-08T07:00:00.000Z', '2026-03-09T06:30:00.000Z']);
  assert.deepEqual(times('30 1 * * *', '2026-11-01T04:00:00Z'),
    ['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
  assert.deepEqual(times('*/30 1 * * *', '2026-11-01T04:00:00Z', 4),
    ['2026-11-01T05:00:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.throws(() => times('0 30 1 * * *', '2026-11-01T04:00:00Z'));
});
