import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { isComposingKey } from "./composing";
import { cn } from "@/lib/utils";
import { fieldControl } from "./input";

/**
 * A form field's textarea. `variant="editor"` is for text
 * the user writes as a file or as code (the Markdown body, config.yaml's
 * agents block, an RE2 pattern), so it is monospaced and keeps text-base at
 * the narrow width, where columns must not shift. Prose stays `default`.
 */
const textareaVariants = cva(`${fieldControl} resize-y`, {
  variants: {
    variant: {
      default: "min-h-29",
      editor:
        "min-h-59 font-mono text-base narrow:min-h-56 narrow:text-base",
    },
  },
  defaultVariants: { variant: "default" },
});

function Textarea({
  className,
  variant,
  ...props
}: React.ComponentProps<"textarea"> & VariantProps<typeof textareaVariants>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(textareaVariants({ variant }), className)}
      {...props}
      onKeyDown={(event) => {
        // Native composition keeps its default; the shared submit boundary refuses implicit submission.
        if (isComposingKey(event)) return;
        props.onKeyDown?.(event);
      }}
    />
  );
}

export { Textarea };
