import { expect, type Page } from '@playwright/test';
import { settleMotion } from './fixtures.ts';

/** Measure the served queue and the actual pointer target, including when a squeezed box is still "visible". */
export async function queueGeometry(page: Page) {
  return page.locator('[data-coordinator-queue-over]').evaluate((over: HTMLElement) => {
    const fold = over.querySelector<HTMLElement>('[data-coordinator-queue-fold]')!;
    const first = over.querySelector<HTMLElement>('[data-coordinator-waiting]')!;
    const withdraw = first.querySelector<HTMLElement>('[data-coordinator-withdraw]')!;
    const doc = over.ownerDocument, view = doc.defaultView!, area = over.offsetParent as HTMLElement;
    const button = doc.querySelector<HTMLElement>('[data-coordinator-queue-button]')!;
    const head = area.querySelector<HTMLElement>('[data-coordinator-panel-head]');
    const input = doc.querySelector<HTMLElement>('[data-one-input]')!;
    const box = over.getBoundingClientRect(), hit = withdraw.getBoundingClientRect();
    const style = view.getComputedStyle(over), bottom = Number.parseFloat(style.bottom);
    const desired = bottom + fold.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom;
    return { height: box.height, least: fold.parentElement!.offsetHeight + first.offsetHeight,
      withdrawHit: withdraw.contains(doc.elementFromPoint(hit.x + hit.width / 2, hit.y + hit.height / 2)),
      top: box.top, headBottom: head?.getBoundingClientRect().bottom ?? area.getBoundingClientRect().top,
      bottom: box.bottom, inputTop: input.getBoundingClientRect().top,
      areaHeight: area.clientHeight, anchor: Number.parseFloat(style.getPropertyValue('--queue-anchor')),
      minBottom: Number.parseFloat(style.getPropertyValue('--queue-min-bottom')),
      usedBottom: bottom, maxHeight: style.maxHeight, desired,
      anchorDifference: fold.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom,
    };
  });
}

/**
 * The rows' own scroller and what the room above the queue keeps in reach. `rows` are measured where they are now; a row
 * is whole when its box lies inside the list's visible part. `reserve` is the served --queue-top, recorded only: the
 * check holds main's head room as its own number. `needed` is what the rows and fold take, `given` the queue's height.
 */
export async function queueRows(page: Page) {
  return page.locator('[data-coordinator-queue-over]').evaluate((over: HTMLElement) => {
    const doc = over.ownerDocument, view = doc.defaultView!, area = over.offsetParent as HTMLElement;
    const list = over.querySelector<HTMLElement>('ol')!, fold = over.querySelector<HTMLElement>('[data-coordinator-queue-fold]')!;
    const input = doc.querySelector<HTMLElement>('[data-one-input]')!;
    const seen = list.getBoundingClientRect(), areaBox = area.getBoundingClientRect(), box = over.getBoundingClientRect();
    const top = view.getComputedStyle(over).getPropertyValue('--queue-top').trim();
    const reserve = Number.parseFloat(top) * (top.endsWith('rem') ? Number.parseFloat(view.getComputedStyle(doc.documentElement).fontSize) : 1);
    const hits = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return element.contains(doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    };
    const rows = [...list.querySelectorAll<HTMLElement>('[data-coordinator-waiting]')].map(row => {
      const rect = row.getBoundingClientRect(), opener = row.querySelector<HTMLElement>('button[aria-expanded]')!;
      return { text: opener.textContent ?? '', top: rect.top, bottom: rect.bottom,
        whole: rect.top >= seen.top - 0.5 && rect.bottom <= seen.bottom + 0.5,
        withdrawHit: hits(row.querySelector('[data-coordinator-withdraw]')!), openerHit: hits(opener) };
    });
    // What stands in the middle of the head room main keeps (2.875rem, 46px): a press there must reach the conversation.
    const headY = areaBox.top + 23;
    const inHead = doc.elementFromPoint(areaBox.left + areaBox.width / 2, headY);
    return { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, scrollTop: list.scrollTop,
      scrollable: list.scrollHeight > list.clientHeight + 1, overflowY: view.getComputedStyle(list).overflowY,
      listTop: seen.top, listBottom: seen.bottom, rows,
      foldWhole: fold.getBoundingClientRect().top >= box.top - 0.5 && fold.getBoundingClientRect().bottom <= box.bottom + 0.5, foldHit: hits(fold),
      reserve, areaTop: areaBox.top, top: box.top, bottom: box.bottom, inputTop: input.getBoundingClientRect().top,
      needed: list.scrollHeight + fold.parentElement!.offsetHeight, given: box.height,
      headPressReachesConversation: !!inHead && !over.contains(inHead) && area.contains(inHead),
      headTarget: inHead ? `${inHead.tagName.toLowerCase()}${[...inHead.attributes].filter(a => a.name.startsWith('data-')).map(a => `[${a.name}]`).join('')}` : null,
    };
  });
}

export async function usableQueue(page: Page) {
  const over = page.locator('[data-coordinator-queue-over]');
  await expect(over).toBeVisible();
  await expect(page.locator('[data-grow-back]')).toHaveCount(0);
  await settleMotion(page, over, true);
  await expect.poll(async () => {
    const g = await queueGeometry(page);
    return { rowAndFold: g.height >= g.least, withdrawHit: g.withdrawHit,
      belowHead: g.top >= g.headBottom - 1, aboveInput: g.bottom <= g.inputTop };
  }).toEqual({ rowAndFold: true, withdrawHit: true, belowHead: true, aboveInput: true });
}
