import type { Page } from '@playwright/test';
import { SAMPLE_NOW } from './fixture/sample.ts';
/** Date is fixed; timers and animation frames keep advancing, including persistent pages. */
export async function applyPageClock(page: { clock: Pick<Page['clock'], 'setFixedTime'> }, fixed: boolean) {
  if (fixed) await page.clock.setFixedTime(new Date(SAMPLE_NOW));
}
