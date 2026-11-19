import { expect, type Page } from '@playwright/test';

/** Watch the actual HTTP reads and the reader DOM while a prefetched task comes forward. */
export function observeReadAhead(page: Page) {
  const requests: string[] = [], completed: string[] = [];
  const key = (url: string) => {
    const parsed = new URL(url), kind = parsed.pathname.split('/').at(-1);
    return ['/api/task/view', '/api/task/history'].includes(parsed.pathname) ? `${parsed.searchParams.get('task')}:${kind}` : null;
  };
  page.on('request', request => { const id = key(request.url()); if (id) requests.push(id); });
  page.on('response', async response => {
    const id = key(response.url());
    // A response still coming when the test ends is simply not completed.
    if (id && response.ok() && await response.finished().then(failure => !failure, () => false)) completed.push(id);
  });
  return {
    async ready(task: string) {
      await expect.poll(() => completed.filter(id => id.startsWith(`${task}:`)).sort()).toEqual([`${task}:history`, `${task}:view`]);
      await page.evaluate(task => {
        const observations: string[] = [];
        Object.assign(window, { readAheadObservations: observations });
        new MutationObserver(() => {
          const reader = document.querySelector('aside[data-reader-mode]');
          if (reader?.querySelector('[data-reader-task-id]')?.textContent !== task) return;
          if (reader.querySelector('[data-skeleton]')) observations.push('skeleton');
          const feed = reader.querySelector('[data-report-feed]');
          if (!feed || feed.getAttribute('aria-busy') === 'true') observations.push('history loading');
        }).observe(document, { subtree: true, childList: true, attributes: true });
      }, task);
    },
    async check(task: string) {
      expect(requests.filter(id => id.startsWith(':')), 'unacquired placeholders must not send empty-ID GETs').toEqual([]);
      const reader = page.locator('aside[data-reader-mode]:visible');
      await expect(reader.locator('[data-report-feed]')).toHaveAttribute('data-history-ready', 'true');
      await expect(reader.locator('[data-skeleton]')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { readAheadObservations: string[] }).readAheadObservations)).toEqual([]);
      expect(requests.filter(id => id.startsWith(`${task}:`)).sort()).toEqual([`${task}:history`, `${task}:view`]);
    },
    requests,
  };
}
