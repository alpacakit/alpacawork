import type * as React from "react";
import { cn } from "@/lib/utils";

/** A native radio with its words beside it, in the field text (text-base); used inside FieldSet. */
function Radio({ label, className, ...props }: Omit<React.ComponentProps<"input">, "type"> & { label: React.ReactNode }) {
  return (
    <label data-slot="radio" className={cn("flex items-center gap-1.5 text-base", className)}>
      <input type="radio" {...props} />
      {label}
    </label>
  );
}

export { Radio };
