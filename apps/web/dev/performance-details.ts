import { ENDPOINT, INPUT_KEYS, RENDER_KEYS, RESOURCE_KEYS, RESOURCE_CATEGORIES, MAX_DETAIL_ENTRIES, emptyDetails, zeroes, type Details } from '../../backend/src/diagnostics/protocol.ts';

export function freshDetails(supported: { eventTiming: boolean; renderPhases: boolean; resource: boolean }): Details {
  return { ...emptyDetails(), input: supported.eventTiming ? zeroes(INPUT_KEYS) : null,
    render: supported.renderPhases ? zeroes(RENDER_KEYS) : null,
    resources: supported.resource ? Object.fromEntries(RESOURCE_CATEGORIES.map(key => [key, zeroes(RESOURCE_KEYS)])) as Details['resources'] : null };
}
const finite = (...values: number[]) => values.every(value => Number.isFinite(value) && value >= 0 && value <= 1e12);
function admit(row: { count: number; dropped: number }) {
  if (row.count >= MAX_DETAIL_ENTRIES) { row.dropped = Math.min(1e12, row.dropped + 1); return false; }
  row.count++; return true;
}
export function addInput(details: Details, entry: PerformanceEntry & { processingStart?: number; processingEnd?: number }) {
  const row = details.input, { startTime, duration, processingStart: start, processingEnd: end } = entry;
  if (!row || typeof start !== 'number' || typeof end !== 'number' || !finite(startTime, duration, start, end) || start < startTime || end < start || !admit(row)) return;
  const delay = start - startTime;
  row.inputDelayMs += delay; row.maxInputDelayMs = Math.max(row.maxInputDelayMs, delay);
  row.processingMs += end - start; row.presentationMs += Math.max(0, startTime + duration - end);
  row.durationMs += duration; row.maxDurationMs = Math.max(row.maxDurationMs, duration);
}
export function addRender(details: Details, entry: PerformanceEntry & { renderStart?: number; styleAndLayoutStart?: number }) {
  const row = details.render, { startTime, duration, renderStart: start, styleAndLayoutStart: style } = entry;
  if (!row || typeof start !== 'number' || typeof style !== 'number' || !finite(startTime, duration, start, style)) return;
  const end = startTime + duration;
  if (start && (start < startTime || start > end) || style && (!start || style < start || style > end) || !admit(row)) return;
  row.preRenderMs += start ? start - startTime : duration;
  row.renderMs += start ? end - start : 0;
  row.styleLayoutMs += style ? end - style : 0;
}
// Translate immediately to a finite category. Never retain or return a URL/path.
export function resourceCategory(entry: PerformanceResourceTiming): typeof RESOURCE_CATEGORIES[number] | undefined {
  try {
    const url = new URL(entry.name, location.href);
    if (url.origin === location.origin) {
      if (url.pathname === ENDPOINT) return;
      if (url.pathname === '/api/events') return 'stream';
      if (url.pathname.startsWith('/api/')) return 'api';
      if (url.pathname.startsWith('/assets/')) return 'asset';
    }
  } catch { return 'other'; }
  return ['script', 'css', 'img', 'image', 'font'].includes(entry.initiatorType) ? 'asset' : 'other';
}
export function addResource(details: Details, category: typeof RESOURCE_CATEGORIES[number], entry: PerformanceResourceTiming) {
  const row = details.resources?.[category];
  if (!row || !finite(entry.duration, entry.transferSize) || !admit(row)) return;
  row.durationMs += entry.duration; row.maxDurationMs = Math.max(row.maxDurationMs, entry.duration); row.transferBytes += entry.transferSize;
  if (finite(entry.requestStart, entry.responseStart) && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
    row.ttfbCount++; row.ttfbMs += entry.responseStart - entry.requestStart;
  }
}
