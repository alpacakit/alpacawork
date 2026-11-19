import { useId, useState, type ReactNode } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/** A hover/tap explanation for a fact the form shows (a fixed part, or the default agent). */
export function AgentSettingsExplained({ children, explanation, className }: { children: ReactNode; explanation: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" aria-describedby={open ? id : undefined}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setOpen(true); }}
      onPointerLeave={event => { if (event.pointerType === 'mouse') setOpen(false); }}
      className={cn('cursor-pointer text-left', className)}>{children}</button></PopoverTrigger>
    <PopoverContent id={id} role="tooltip" style={{ animation: 'none' }} className="w-64 font-sans text-sm" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
      {explanation}
    </PopoverContent>
  </Popover>;
}
/** Fixed adapter prefixes and fixed environment names. */
export function AgentSettingsLock({ children, explanation }: { children: ReactNode; explanation: string }) {
  return <AgentSettingsExplained explanation={explanation} className="rounded-sm bg-line px-2 py-1 text-ink">
    <span aria-hidden="true">🔒 </span>{children}
  </AgentSettingsExplained>;
}
