import type { ReactNode } from 'react';
import { WorkMark } from '@/features/people/RunSteps';

/** Local and accepted waits say the same thing, at the size of the conversation's other states ("Working on it…"), with the
 * work's own mark in the box of the grace's ring (SoonRing), so a message's words stay where they stood from soon to waiting
 * to working, and only the words change. */
export function WaitingStatus({ children }: { children: ReactNode }) {
  return <span role="status" className="inline-flex items-center gap-1.5 text-muted"><WorkMark />{children}</span>;
}
