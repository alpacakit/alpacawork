import type * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Preformatted text in a framed block (plain `pre` and code blocks
 * share it): source, replies, YAML, code. `asChild` puts the frame
 * on another element, as the reader's Markdown does for the `<div>` that holds
 * a code block's copy button and its own `<pre>`.
 */
export function Pre({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"pre"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "pre";
  return (
    <Comp
      className={cn(
        "my-type-block rounded-sm border border-line bg-bg p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]",
        className,
      )}
      {...props}
    />
  );
}
