import type { LimitTone } from "@/domain/limits";
import { cn } from "@/lib/utils";

/* Hallmark · component: usage ring · genre: modern-minimal · theme: the app's own tokens (working, warn, error, line) */

/** How full a ring, a bar or a figure reads: from 80% near (the warning colour), spent at 100% (domain/limits). */
export const TONE_TEXT: Record<LimitTone, string> = { normal: "", near: "text-warn", spent: "text-error" };
export const TONE_FILL: Record<LimitTone, string> = { normal: "bg-working", near: "bg-warn", spent: "bg-error" };
const TONE_STROKE: Record<LimitTone, string> = { normal: "stroke-working", near: "stroke-warn", spent: "stroke-error" };
export const percentText = (value: number) => `${Math.round(value)}%`;

/**
 * A ring filled as far as something is used: the plan limits' and a conversation's context. Empty at 0 and while the
 * figure is unknown; drawn in four arcs (not a spinner's ticks) when there is no limit to measure against (an agent that names no window).
 */
export function UsageRing({ percent, tone, open = false, className }: { percent: number; tone: LimitTone; open?: boolean; className?: string }) {
  const r = 6, length = 2 * Math.PI * r;
  return <svg aria-hidden viewBox="0 0 16 16" className={cn("size-4 flex-none -rotate-90", className)}>
    <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-line" strokeDasharray={open ? `${length / 4 - 3} 3` : undefined} />
    {percent > 0 && <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className={TONE_STROKE[tone]}
      strokeDasharray={`${length * Math.min(100, percent) / 100} ${length}`} />}
  </svg>;
}
