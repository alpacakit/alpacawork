import type { SVGProps } from "react";
import type { Ball } from "@alpacawork/contract";
import type { TaskState } from "@/data/types";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import { stateLook, TONE, useStateLook } from "./tone";

/** The same state icon and colour in cards, search, choices, and the reader (components/ui/tone). */
export function StateIcon({ state, ball = null, className, ...props }: {
  state: TaskState; ball?: Ball | null;
} & Omit<SVGProps<SVGSVGElement>, "children" | "name">) {
  const { tone, icon } = stateLook(state, ball);
  return <Icon name={icon} className={cn(TONE[tone], className)} {...props} />;
}

/** A task's state as icon and word; only your turn is said in its colour. */
export function StateLabel({ state, className, ball = null }: { state: TaskState; className?: string; ball?: Ball | null }) {
  const { word, turn } = useStateLook(state, ball);
  return (
    <span
      data-state={state}
      className={cn("inline-flex flex-none items-center gap-1 text-xs whitespace-nowrap", turn ? TONE.turn : TONE.quiet, className)}
    >
      <StateIcon state={state} ball={ball} className="size-3" />
      {word}
    </span>
  );
}
