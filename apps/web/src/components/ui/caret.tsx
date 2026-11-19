import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** A single cue for expanding content in place. */
export function Caret({ open = false, className = "" }: { open?: boolean; className?: string }) {
  return <svg data-list-caret viewBox="0 0 12 12" aria-hidden="true" className={`-mr-0.5 size-2.5 flex-none fill-current ${open ? "rotate-90" : ""} ${className}`}>
    <path d="M4 2l5 4-5 4z" />
  </svg>;
}

/** Native disclosure row: the whole summary, rather than the cue, is the target. */
export function DisclosureSummary({ className, ...props }: ComponentProps<"summary">) {
  return <summary className={cn("flex min-h-6 cursor-pointer list-none items-center narrow:min-h-8 [&::-webkit-details-marker]:hidden", className)} {...props} />;
}
