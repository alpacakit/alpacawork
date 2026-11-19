import type { SVGProps } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * The conversation's one mark for an answer not read yet, wherever it stands: the way into the folded
 * conversation, and a conversation ready to be asked. It is the conversation's own bubble, the
 * one the way in shows once read, with a point in the not-yet-read colour at its corner: the same box and stroke as
 * the icons and words beside it, so the point does not float alone, and reading it takes only the point away.
 * The point reaches past the circle inscribed in its box, so the mark never clips to its box's shape: on a rail's
 * disc (rounded) it stays whole, not cut at the corner.
 * `label`: its name, where it is the only thing saying so; without, it is hidden from assistive technology.
 */
export function UnreadMark({ label, className, ...props }: { label?: string } & Omit<SVGProps<SVGSVGElement>, "children" | "name">) {
  return <Icon name="chatNew" data-unread-mark role={label ? "img" : undefined} aria-hidden={label ? undefined : true} aria-label={label}
    className={cn("size-3.5 overflow-visible text-muted", className)} {...props} />;
}
