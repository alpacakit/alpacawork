import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, morningUntil, nextLocalTime, quietEnd } from '@alpacawork/contract';
import { Presence } from '@alpacawork/backend/test-dist/receiver/presence.js';

const settings = () => defaultSettings();
const at = (value: string) => Date.parse(value);
const epoch = at('2026-10-14T00:00:00Z');
function fixture(onActivity = () => {}) {
  let elapsed = 0;
  const presence = new Presence(() => elapsed, onActivity);
  const seq = new Map<string, number>();
  return { presence, time: (time: number) => { elapsed = time; },
    report: (screen: string, touch: number | null, hidden: number | null = null, sequence?: number) => {
      const next = sequence ?? (seq.get(screen) ?? 0) + 1;
      seq.set(screen, Math.max(next, seq.get(screen) ?? 0));
      presence.report({ screen, seq: next, touchSeq: touch === null ? 0 : touch + 1,
        touchedAgo: touch === null ? null : elapsed - touch,
        hiddenAgo: hidden === null ? null : elapsed - hidden });
    },
    state: () => presence.status(settings(), epoch + elapsed).state };
}

describe('presence', () => {
  test('visible idle expires at the touch time, even when the report arrives late or is repeated', () => {
    const h = fixture();
    assert.equal(h.state(), 'away');
    h.time(15_000); h.report('A', 0);
    h.time(299_999); h.report('A', 0);
    h.presence.report({ screen: 'A', seq: 3, touchSeq: 1, touchedAgo: 0, hiddenAgo: null });
    assert.equal(h.state(), 'present');
    h.time(300_000);
    assert.equal(h.state(), 'away');
    assert.equal(new Presence().status(settings()).state, 'away');
  });

  test('leaving the last touched screen becomes away exactly 30 seconds after hiding', () => {
    const h = fixture();
    h.report('A', 0);
    h.time(10_000); h.report('A', 0, 10_000);
    h.time(39_999);
    assert.equal(h.state(), 'present');
    // Retrying the current state cannot restart the grace period.
    h.report('A', 0, 10_000);
    h.time(40_000);
    assert.equal(h.state(), 'away');
    h.time(150_000);
    assert.equal(h.state(), 'away');
  });

  test('returning without input cancels the leave and restarts idle from the return touch', () => {
    const h = fixture();
    h.report('A', 0);
    h.time(10_000); h.report('A', 0, 10_000);
    h.time(25_000); h.report('A', 25_000);
    h.time(40_000);
    assert.equal(h.state(), 'present');
    h.time(324_999);
    assert.equal(h.state(), 'present');
    h.time(325_000);
    assert.equal(h.state(), 'away');
  });

  test('a faster report of a second tap event cannot move its screen back in time or lose its leave', () => {
    let elapsed = 1_500;
    const presence = new Presence(() => elapsed);
    presence.report({ screen: 'phone', seq: 1, touchSeq: 1, touchedAgo: 0, hiddenAgo: null });
    elapsed = 3_100;
    presence.report({ screen: 'phone', seq: 2, touchSeq: 2, touchedAgo: 2_999, hiddenAgo: 0 });
    elapsed = 33_099;
    assert.equal(presence.status(settings()).state, 'present');
    for (const time of [33_100, 60_000, 299_000]) {
      elapsed = time;
      assert.equal(presence.status(settings()).state, 'away');
    }
    presence.report({ screen: 'phone', seq: 3, touchSeq: 2, touchedAgo: elapsed - 1, hiddenAgo: elapsed - 3_000 });
    assert.equal(presence.status(settings()).state, 'away');
    presence.report({ screen: 'phone', seq: 4, touchSeq: 3, touchedAgo: 0, hiddenAgo: null });
    assert.equal(presence.status(settings()).state, 'present');
  });

  test('only the last touched screen can leave; untouched visible pages do not keep presence', () => {
    const h = fixture();
    h.report('A', 0);
    h.time(5_000); h.report('B', 5_000);
    h.time(10_000); h.report('A', 0, 10_000);
    h.time(40_000);
    assert.equal(h.state(), 'present');
    h.report('B', 5_000, 40_000);
    h.report('C', null);
    h.time(70_000);
    assert.equal(h.state(), 'away');
  });

  test('late older touches and reordered same-screen reports cannot replace newer state', () => {
    const h = fixture();
    h.time(5_000); h.report('B', 5_000);
    h.time(10_000); h.report('A', 0, 0);
    h.time(35_000);
    assert.equal(h.state(), 'present');
    h.report('B', 5_000, 10_000, 3);
    h.report('B', 5_000, null, 2);
    h.time(40_000);
    assert.equal(h.state(), 'away');
    h.report('B', 5_000, null, 3);
    assert.equal(h.state(), 'away');
  });

  test('expired screen history cannot restore presence after manual away, but a new touch can', () => {
    const h = fixture();
    h.report('A', 0);
    h.time(5_000); h.report('B', 5_000);
    // A newer screen puts A and B beyond every idle choice; their history can now be forgotten.
    h.time(905_001); h.report('C', 905_001);
    h.report('B', 5_000, 40_000);
    assert.equal(h.state(), 'present');
    h.presence.away();
    h.time(965_001); h.report('B', 5_000);
    assert.equal(h.state(), 'away');
    h.report('B', 965_001);
    assert.equal(h.state(), 'present');
    h.report('B', 5_000, 40_000, 3);
    assert.equal(h.state(), 'present');
  });

  test('manual away rejects touches made during its guard even if they arrive after it', () => {
    const h = fixture();
    h.report('A', 0);
    h.presence.away();
    h.time(20_000); h.report('B', 20_000);
    assert.equal(h.state(), 'away');
    h.time(61_000); h.report('B', 20_000);
    assert.equal(h.state(), 'away');
    h.report('A', 61_000);
    assert.equal(h.state(), 'present');
  });

  test('telemetry follows new touches, never visibility reports or duplicates', () => {
    let activity = 0;
    const h = fixture(() => activity++);
    h.report('A', null, 0);
    h.report('A', 0);
    h.time(10_000);
    h.report('A', 0, 10_000);
    h.report('A', 0, 10_000);
    h.time(25_000);
    h.report('A', 25_000);
    assert.equal(activity, 2);
  });

  test('a backward wall-clock adjustment does not extend manual away or activity', () => {
    let elapsed = 0;
    const presence = new Presence(() => elapsed);
    const now = at('2026-10-14T01:00:00Z');
    const touch = () => presence.report({ screen: 'A', seq: elapsed + 1, touchSeq: elapsed + 1, touchedAgo: 0, hiddenAgo: null });
    touch();
    presence.away();
    elapsed = 59_999;
    touch();
    assert.equal(presence.status(settings(), now - 3_600_000).state, 'away');
    elapsed = 60_000;
    touch();
    assert.equal(presence.status(settings(), now - 3_600_000).state, 'present');
    elapsed = 360_000;
    assert.equal(presence.status(settings(), now - 3_600_000).state, 'away');
  });

  test('quiet time crosses midnight in the saved time zone and takes priority', () => {
    let elapsed = 0;
    const presence = new Presence(() => elapsed);
    const values = { ...settings(), 'push.quiet': true, 'push.timeZone': 'Asia/Tokyo' };
    const start = at('2026-10-14T14:00:00.000Z'); // 23:00 in Tokyo
    presence.report({ screen: 'A', seq: 1, touchSeq: 1, touchedAgo: 0, hiddenAgo: null });
    assert.equal(quietEnd(start, values), at('2026-10-14T23:00:00.000Z'));
    assert.deepEqual(presence.status(values, start), { state: 'muted', until: '2026-10-14T23:00:00.000Z' });
    elapsed = at('2026-10-14T23:00:00.000Z') - start;
    assert.equal(presence.status(values, at('2026-10-14T23:00:00.000Z')).state, 'away');
    assert.equal(morningUntil(start, values), at('2026-10-14T23:00:00.000Z'));
    assert.equal(morningUntil(start, { ...values, 'push.quiet': false }), at('2026-10-14T23:00:00.000Z'));
    assert.equal(morningUntil(at('2026-10-13T21:00:00.000Z'), values), at('2026-10-13T23:00:00.000Z'));
  });

  test('manual mute overrides presence and extends through an overlapping quiet interval', () => {
    const presence = new Presence();
    const values = { ...settings(), 'push.quiet': true, 'push.timeZone': 'UTC',
      'push.mutedUntil': '2026-10-14T23:00:00.000Z' };
    const start = at('2026-10-14T21:00:00.000Z');
    presence.report({ screen: 'A', seq: 1, touchSeq: 1, touchedAgo: 0, hiddenAgo: null });
    assert.deepEqual(presence.status(values, start), { state: 'muted', until: '2026-10-15T08:00:00.000Z' });
  });

  test('resuming during quiet hours takes effect now and the next interval still runs', () => {
    const presence = new Presence();
    const values = { ...settings(), 'push.quiet': true, 'push.timeZone': 'UTC',
      'push.quietResumedUntil': '2026-10-15T08:00:00.000Z' };
    assert.equal(presence.status(values, at('2026-10-14T23:00:00Z')).state, 'away');
    assert.deepEqual(presence.status(values, at('2026-10-15T22:00:00Z')),
      { state: 'muted', until: '2026-10-16T08:00:00.000Z' });
  });

  test('daylight saving gaps and repeated hours use the next local occurrence', () => {
    const values = { ...settings(), 'push.quiet': true, 'push.quietFrom': '22:00',
      'push.quietTo': '02:30', 'push.timeZone': 'America/New_York' };
    assert.equal(quietEnd(at('2027-03-14T06:00:00Z'), values), at('2027-03-14T07:30:00Z'));
    assert.equal(morningUntil(at('2027-03-13T15:00:00Z'), values), at('2027-03-14T07:30:00Z'));
    assert.equal(nextLocalTime(at('2027-11-07T05:45:00Z'), '01:30', 'America/New_York'),
      at('2027-11-07T06:30:00Z'));
  });
});

for (const zone of ['Asia/Tokyo', 'UTC', 'America/New_York']) {
  // All three zones have a fixed offset on this date; instants below are explicit.
  const offset = zone === 'Asia/Tokyo' ? '+09:00' : zone === 'UTC' ? 'Z' : '-04:00';
  // Every clock once; other zones only have to read the same local days from their own offset.
  const clocks = [['23:30', 17], ['00:30', 16], ['10:59', 16], ['11:00', 17], ['14:00', 17]] as const;
  for (const [clock, day] of zone === 'Asia/Tokyo' ? clocks : clocks.slice(0, 2)) {
    test(`morning pause chooses the next 11:00 at ${clock} in ${zone}`, () => {
      const values = { ...settings(), 'push.quiet': true, 'push.quietFrom': '23:00',
        'push.quietTo': '11:00', 'push.timeZone': zone };
      const start = at(`2026-10-16T${clock}:00${offset}`);
      const end = at(`2026-10-${day}T11:00:00${offset}`);
      assert.equal(morningUntil(start, values), end);
      const paused = { ...values, 'push.mutedUntil': new Date(end).toISOString() };
      const presence = new Presence();
      assert.deepEqual(presence.status(paused, start), { state: 'muted', until: new Date(end).toISOString() });
      assert.equal(presence.status(paused, end).state, 'away');
    });
  }
}

test('default morning pause uses the next 08:00 even before dawn', () => {
  const values = { ...settings(), 'push.quiet': false, 'push.timeZone': 'Asia/Tokyo' };
  assert.equal(morningUntil(at('2026-10-15T15:30:00Z'), values), at('2026-10-15T23:00:00Z'));
  assert.equal(morningUntil(at('2026-10-15T23:00:00Z'), values), at('2026-10-16T23:00:00Z'));
});

test('manual pause, quiet interval and resume exemption use the same continuous end', () => {
  const presence = new Presence();
  const values = { ...settings(), 'push.quiet': true, 'push.quietFrom': '23:00',
    'push.quietTo': '11:00', 'push.timeZone': 'Asia/Tokyo',
    'push.quietResumedUntil': '2026-10-16T02:00:00.000Z' };
  const start = at('2026-10-15T15:30:00Z'); // 00:30 JST, resumed during this quiet interval
  assert.equal(presence.status(values, start).state, 'away');
  assert.deepEqual(presence.status({ ...values, 'push.mutedUntil': '2026-10-15T16:30:00.000Z' }, start),
    { state: 'muted', until: '2026-10-15T16:30:00.000Z' });
  assert.deepEqual(presence.status({ ...values, 'push.mutedUntil': '2026-10-16T15:30:00.000Z' }, start),
    { state: 'muted', until: '2026-10-17T02:00:00.000Z' });
  assert.deepEqual(presence.status(values, at('2026-10-16T14:30:00Z')),
    { state: 'muted', until: '2026-10-17T02:00:00.000Z' });
});

test('a DST gap can connect consecutive daily quiet intervals until an actual resume', () => {
  const presence = new Presence();
  const values = { ...settings(), 'push.quiet': true, 'push.quietFrom': '03:00',
    'push.quietTo': '02:30', 'push.timeZone': 'America/New_York',
    'push.mutedUntil': '2027-03-13T08:45:00.000Z' };
  // 02:45 EST: the manual pause reaches today's quiet interval. Tomorrow's 02:30
  // shifts to 03:30 EDT, which is already inside the following quiet interval.
  const start = at('2027-03-13T07:45:00Z');
  assert.deepEqual(presence.status(values, start), { state: 'muted', until: '2027-03-15T06:30:00.000Z' });
  assert.deepEqual(presence.status(values, at('2027-03-14T07:30:00Z')),
    { state: 'muted', until: '2027-03-15T06:30:00.000Z' });
  assert.equal(presence.status(values, at('2027-03-15T06:30:00Z')).state, 'away');
});
