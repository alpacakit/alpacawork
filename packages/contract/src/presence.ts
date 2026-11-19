import { MORNING_TIME, type SettingValues } from './personal-settings.js';

const localFormatter = new Map<string, Intl.DateTimeFormat>();
function parts(at: number, zone: string) {
  let formatter = localFormatter.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    localFormatter.set(zone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(at)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return { year: values.year!, month: values.month!, day: values.day!, hour: values.hour!, minute: values.minute! };
}
function localMinute(at: number, zone: string) {
  const value = parts(at, zone);
  return value.hour * 60 + value.minute;
}
function minuteOf(value: string) { const [hour, minute] = value.split(':').map(Number); return hour! * 60 + minute!; }
function fromLocal(day: { year: number; month: number; day: number }, dayOffset: number, minute: number, zone: string): number[] {
  const wanted = Date.UTC(day.year, day.month - 1, day.day + dayOffset, Math.floor(minute / 60), minute % 60);
  const target = new Date(wanted);
  const offsets = new Set<number>();
  for (const sample of [wanted - 36 * 60 * 60_000, wanted, wanted + 36 * 60 * 60_000]) {
    const local = parts(sample, zone);
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample);
  }
  const candidates = [...offsets].map(offset => wanted - offset).filter(candidate => {
    const local = parts(candidate, zone);
    return local.year === target.getUTCFullYear() && local.month === target.getUTCMonth() + 1 &&
      local.day === target.getUTCDate();
  });
  const exact = candidates.filter(candidate => localMinute(candidate, zone) === minute).sort((a, b) => a - b);
  if (exact.length) return exact;
  // A spring-forward gap has no matching wall time. Shift that time forward by the gap.
  return candidates.filter(candidate => localMinute(candidate, zone) > minute)
    .sort((a, b) => localMinute(a, zone) - localMinute(b, zone)).slice(0, 1);
}
/** Next local wall clock time after `at`, using the saved browser time zone. */
export function nextLocalTime(at: number, time: string, zone: string): number {
  const day = parts(at, zone);
  const minute = minuteOf(time);
  for (let offset = 0; offset < 4; offset++) {
    for (const candidate of fromLocal(day, offset, minute, zone)) {
      if (candidate > at) return candidate;
    }
  }
  throw new Error('No next local time');
}
export function quietEnd(at: number, settings: SettingValues): number | null {
  if (settings['push.quiet'] !== true) return null;
  const from = minuteOf(String(settings['push.quietFrom']));
  const to = minuteOf(String(settings['push.quietTo']));
  if (from === to) return null;
  const zone = String(settings['push.timeZone']);
  const minute = localMinute(at, zone);
  const inside = from < to ? minute >= from && minute < to : minute >= from || minute < to;
  return inside ? nextLocalTime(at, String(settings['push.quietTo']), zone) : null;
}
export function morningUntil(at: number, settings: SettingValues): number {
  const zone = String(settings['push.timeZone']);
  const time = settings['push.quiet'] === true ? String(settings['push.quietTo']) : MORNING_TIME;
  return nextLocalTime(at, time, zone);
}

/** End of the continuous union of manual and non-resumed daily quiet intervals. */
export function notificationResumeTime(at: number, settings: SettingValues): number | null {
  const manual = typeof settings['push.mutedUntil'] === 'string' ? Date.parse(settings['push.mutedUntil']) : 0;
  const resumed = typeof settings['push.quietResumedUntil'] === 'string' ? Date.parse(settings['push.quietResumedUntil']) : 0;
  const scheduledEnd = (instant: number) => instant < resumed ? null : quietEnd(instant, settings);
  let until = Math.max(manual > at ? manual : 0, scheduledEnd(at) ?? 0);
  if (!until) return null;
  // Follow connected intervals to their actual end, including intervals joined by a DST gap.
  for (;;) {
    const next = scheduledEnd(until);
    if (next === null || next <= until) return until;
    until = next;
  }
}
