import assert from 'node:assert/strict';
import test from 'node:test';
import { messageTime } from '../apps/web/src/features/coordinator/message-time.ts';

test('message clocks match native locale output across dates, calendars and live device zone changes', () => {
  const savedZone = process.env.TZ, offsets = new Set<number>();
  try {
    for (const language of ['ja-JP', 'en-US', 'ar-EG', 'th-TH', 'ja-JP-u-ca-japanese']) {
      for (const zone of ['Asia/Tokyo', 'America/New_York', 'Europe/London', 'Pacific/Chatham']) {
        process.env.TZ = zone;
        offsets.add(new Date().getTimezoneOffset());
        for (const at of [new Date().toISOString(), '2026-11-03T00:00:00Z', '2026-06-01T12:15:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '0001-01-01T00:00:00Z', new Date(8.64e15).toISOString(), new Date(-8.64e15).toISOString()]) {
          const date = new Date(at);
          const expected = date.toLocaleString(language, { ...(date.toDateString() !== new Date().toDateString() ? { month: 'numeric', day: 'numeric' } : {}),
            hour: '2-digit', minute: '2-digit', hour12: false });
          assert.equal(messageTime(at, language), expected, `${zone} ${language} ${at}`);
        }
      }
    }
    assert.equal(offsets.size, 4, 'the process actually exercised distinct device time zones');
    assert.equal(messageTime('invalid', 'en-US'), 'Invalid Date');
  } finally { if (savedZone === undefined) delete process.env.TZ; else process.env.TZ = savedZone; }
});
