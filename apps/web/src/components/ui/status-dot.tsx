import { cn } from "@/lib/utils";

/** The small receiving/stopped dot. */
export function StatusDot({ stopped = false, className }: { stopped?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1 flex-none rounded-full", stopped ? "bg-warn" : "bg-new", className)}
    />
  );
}
