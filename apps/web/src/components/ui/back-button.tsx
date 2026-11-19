import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Back: one face wherever a surface goes back to what it was opened from (the reader's head, a dialog opened from
 * another). The head's buttons' height and corner, a left chevron and the word; where the room runs short a
 * caller hides the word (`labelClassName`) and narrows the face (`className`).
 */
export function BackButton({ label, labelClassName, className, ...props }: Omit<React.ComponentProps<typeof Button>, "children" | "variant"> & {
  label: string; labelClassName?: string;
}) {
  return <Button variant="ghost" aria-label={label} title={label} {...props}
    className={cn("flex-none gap-0.5 rounded-full pr-2.5 pl-1.5 text-ink narrow:min-h-11 narrow:pl-0.5", className)}>
    <Icon name="left" className="size-4 flex-none" /><span className={labelClassName}>{label}</span>
  </Button>;
}
