/**
 * The one decision of a screen's device for usage data: its kind and its system, from what the browser says of itself.
 * Only the resulting name leaves the tab; the user agent's words, a size or a version never do.
 */
import type { TelemetryDevice } from '@alpacawork/contract/telemetry';

export function deviceOf(browser: Pick<Navigator, 'userAgent' | 'maxTouchPoints'>): TelemetryDevice {
  const agent = browser.userAgent;
  if (/iPhone|iPod/.test(agent)) return 'phone.ios';
  // iPadOS Safari names itself a Mac; only a touch screen tells them apart.
  if (/iPad/.test(agent) || /Macintosh/.test(agent) && browser.maxTouchPoints > 1) return 'tablet.ios';
  // Android phones say Mobile; Android tablets do not.
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? 'phone.android' : 'tablet.android';
  if (/CrOS/.test(agent)) return 'desktop.chromeos';
  if (/Windows/.test(agent)) return 'desktop.windows';
  if (/Macintosh/.test(agent)) return 'desktop.macos';
  if (/Linux/.test(agent)) return 'desktop.linux';
  return /Mobi/.test(agent) ? 'phone.other' : /Tablet/.test(agent) ? 'tablet.other' : 'desktop.other';
}
