import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Label/value rows in two columns: the reader's
 * extracted summary and the diagnostics facts. Children are `<dt>`/`<dd>` pairs.
 */
export function SummaryGrid({ className, ...props }: React.ComponentProps<"dl">) {
  return (
    <dl
      className={cn(
        "my-4 grid grid-cols-[--spacing(16)_minmax(0,1fr)] gap-3 narrow:grid-cols-[--spacing(15)_minmax(0,1fr)]",
        "[&>dd]:m-0 [&>dt]:text-sm [&>dt]:text-muted",
        className,
      )}
      {...props}
    />
  );
}
