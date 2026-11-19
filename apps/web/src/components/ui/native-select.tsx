import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { singleLineControl } from "./input";

/**
 * A native `<select>`, used everywhere (the OS menu, not a
 * custom popover). `default` is a bare select (toolbar filter);
 * `field` is a select inside a form's Field, the same frame and text as Input.
 * Both own their text size (text-base) rather than inheriting it.
 */
const selectVariants = cva("max-w-full cursor-pointer disabled:opacity-50", {
  variants: {
    variant: {
      default: "min-h-control-sm rounded-md border border-line bg-bg px-2 text-base",
      field: singleLineControl,
    },
  },
  defaultVariants: { variant: "default" },
});

function NativeSelect({
  className,
  variant,
  ...props
}: React.ComponentProps<"select"> & VariantProps<typeof selectVariants>) {
  return (
    <select
      data-slot="native-select"
      className={cn(selectVariants({ variant }), className)}
      {...props}
    />
  );
}

export { NativeSelect };
