import { expect, test } from 'vitest';
import { TELEMETRY_EVENT_ATTRIBUTES } from '@alpacawork/contract/telemetry';
import { deviceOf } from '../src/features/telemetry/device';

// Real user agents of the main devices: each becomes one fixed name, whatever the browser or its version.
const seen = [
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', 5, 'phone.ios'],
  ['Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 5, 'tablet.ios'],
  // iPadOS Safari asks for desktop sites as a Mac: only its touch points tell it from one.
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 5, 'tablet.ios'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', 0, 'desktop.macos'],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 5, 'phone.android'],
  ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 5, 'tablet.android'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 10, 'desktop.windows'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 0, 'desktop.linux'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0, 'desktop.chromeos'],
  ['Mozilla/5.0 (Mobile; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5', 0, 'phone.other'],
  ['', 0, 'desktop.other'],
] as const;

test('a screen is counted by its device kind and system as one listed name, never by its user agent', () => {
  for (const [userAgent, maxTouchPoints, device] of seen) {
    expect(deviceOf({ userAgent, maxTouchPoints }), userAgent).toBe(device);
    expect(TELEMETRY_EVENT_ATTRIBUTES[0].screen).toContain(device);
  }
});
