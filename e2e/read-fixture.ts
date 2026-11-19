import type { Page } from '@playwright/test';
/** Fault/position cases require a cold read. Clear only this fixture context's read checkpoint,
 * through actual IDB; storage remains enabled and the next document may save normally. */
export async function clearReadCheckpoint(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('alpacawork-read-checkpoint');
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  }));
}
export async function reloadWithoutReadCheckpoint(page: Page) {
  await clearReadCheckpoint(page);
  await page.reload();
}
