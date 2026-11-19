import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * A yes or no that takes effect at once. Off is an outline and a grey knob, on is filled in ink: the two are told apart
 * by shape as well as by where the knob stands, and the outline is seen on a raised surface in either theme. On a phone
 * the area a finger presses reaches past what is drawn, to 44px each way.
 */
export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return <SwitchPrimitive.Root data-slot="switch" className={cn(
    'relative inline-flex h-5.5 w-9.5 shrink-0 cursor-pointer items-center rounded-full border border-soft bg-transparent transition-colors data-[state=checked]:border-ink data-[state=checked]:bg-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50 narrow:after:absolute narrow:after:-inset-x-1 narrow:after:-inset-y-3 narrow:after:content-[\'\']', className)} {...props}>
    <SwitchPrimitive.Thumb className="block size-4 rounded-full bg-soft transition-transform data-[state=checked]:translate-x-4.5 data-[state=checked]:bg-bg data-[state=unchecked]:translate-x-0.5" />
  </SwitchPrimitive.Root>;
}
