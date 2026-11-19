import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Slot } from "radix-ui";

/**
 * shadcn's Button. Every button
 * on the screen is this component; a place that draws its buttons smaller or
 * larger passes the difference in `className`. A button's face (FACE: its height,
 * padding, hover fill and words) belongs to every variant but `ref`. Its words
 * are text-sm wherever it stands (a button's words are one step under
 * the body they act on, the same in a dialog, a form and a card); a small
 * control beside text-xs notes passes `text-xs`.
 *
 * variant — mock class
 * - default: `.primary` (filled with the ink colour; the main action)
 * - outline: `.outline`
 * - ghost:   a bare `button` (background only on hover)
 * - quiet:  small view and utility actions
 * - ref:    an inline reference that opens content: no face, a link in the sentence (`inline-link`), so its words take
 *           the sentence's size and fold as the sentence's do
 * size — mock class
 * - default: a bare `button`
 * - icon:    `.icon-button` (32px square)
 * - bar:     a head's icon button (the list's ⚙): the 32px square on a computer, 44px on a phone (the reader's head uses HEAD_MARK)
 */
const FACE = "min-h-control-sm gap-1.5 px-2 py-1 text-sm whitespace-nowrap hover:bg-hover";

const buttonVariants = cva(
  "inline-flex cursor-pointer touch-manipulation items-center justify-center rounded-sm border-0 bg-transparent disabled:cursor-default disabled:opacity-38",
  {
    variants: {
      variant: {
        default: cn(FACE, "border border-solid border-ink bg-ink text-bg hover:border-muted hover:bg-muted hover:text-bg"),
        outline: cn(FACE, "border border-solid border-line bg-lit"),
        ghost: FACE,
        quiet: cn(FACE, "px-1 text-muted hover:text-ink narrow:min-h-8"),
        ref: "inline-link text-left",
      },
      size: {
        default: "",
        icon: "w-8 p-0 narrow:min-h-8 narrow:w-8",
        bar: "w-8 p-0 narrow:size-11 narrow:min-h-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * A head's icon button: the reader head's copy mark, its list steps, Expand and ×, a related list's ×, and the
 * marks over a table. One face everywhere: a 32px circle, centred on its icon. On a phone the face stays 32px and a
 * finger's 44px reaches 6px round it, so a press never paints a square larger than its neighbours'.
 */
export const HEAD_MARK = "relative size-8 min-h-8 flex-none rounded-full p-0 narrow:size-8 narrow:min-h-8 narrow:after:absolute narrow:after:-inset-1.5 narrow:after:content-[''] disabled:hover:bg-transparent";

/**
 * The room between a head's marks standing in a row: the reader head's (its copy, the list steps, Expand and ×) and
 * the marks over a table. 4px on a computer; 12px on a phone, the finger's reach round each 32px face (HEAD_MARK).
 */
export const HEAD_MARK_GAP = "gap-1 narrow:gap-3";

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
