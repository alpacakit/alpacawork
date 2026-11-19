import * as React from "react";
import { isComposingKey } from "./composing";
import { cn } from "@/lib/utils";

/**
 * The form fields' control (input, textarea and select in a Field): full width, 36px, a thin rule on the lighter surface.
 * The field owns its text size (text-base) instead of inheriting the
 * surrounding text, so a field reads the same in every form; at the narrow
 * width it grows to text-md.
 */
export const fieldControl =
  "w-full min-w-0 min-h-control-md rounded-sm border border-lit-line bg-lit px-2.5 py-2 text-base narrow:text-md placeholder:text-soft focus-visible:border-muted aria-invalid:border-warn read-only:text-muted";

// Single-line controls share padding: their line box must fit the 36px field minimum.
// Textareas retain the larger text padding and their own content-driven height.
export const singleLineControl = cn(fieldControl, "py-1.5");

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      autoComplete="off"
      className={cn(singleLineControl, className)}
      {...props}
      onKeyDown={(event) => {
        // Native composition keeps its default; the shared submit boundary refuses implicit submission.
        if (isComposingKey(event)) return;
        if (event.currentTarget instanceof HTMLInputElement && event.key === "Enter" && !event.metaKey && !event.ctrlKey
          && event.currentTarget.closest('[data-inline-form]')) event.preventDefault();
        props.onKeyDown?.(event);
      }}
    />
  );
}

export { Input };
