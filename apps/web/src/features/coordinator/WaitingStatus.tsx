import type { ReactNode } from 'react';

/** Local and accepted waits say the same thing, at the size of the conversation's other states ("Working on it…"); its ring takes
 * the box of the grace's ring (SoonRing), so a message's words stay where they stood when it goes from soon to waiting. */
export function WaitingStatus({ children }: { children: ReactNode }) {
  return <span role="status" className="inline-flex items-center gap-1.5 text-muted"><svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 flex-none"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>{children}</span>;
}
