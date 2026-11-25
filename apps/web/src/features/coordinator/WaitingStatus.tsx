import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';

/** Local and accepted waits say the same thing, at the size of the conversation's other states ("Working on it…"), with
 * a still ring in the box of the grace's ring (SoonRing): the list's mark for work not started. Nothing moves while a
 * message only waits its turn; the moving mark comes once it is on its way or at work, so a message's words stay where
 * they stood from soon to waiting to working, and only the mark and the words change. */
export function WaitingStatus({ children }: { children: ReactNode }) {
  return <span role="status" className="inline-flex items-center gap-1.5 text-muted"><Icon name="todo" data-waiting-mark className="size-3.5 flex-none" />{children}</span>;
}
