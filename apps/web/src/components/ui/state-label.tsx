import type { SVGProps } from "react";
import type { TaskState } from "@/data/types";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import { stateLook, taskLook, TONE, useTaskLook, type LookTask } from "./tone";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "name">;

/** A state's own icon and colour, where the state itself is said (a choice of state, a time band's end). */
export function StateIcon({ state, className, ...props }: { state: TaskState } & IconProps) {
  const { tone, icon } = stateLook(state);
  return <Icon name={icon} className={cn(TONE[tone], className)} {...props} />;
}

/** A Task's icon and colour, the same wherever it is drawn (components/ui/tone's taskLook). */
export function TaskIcon({ task, className, ...props }: { task: LookTask } & IconProps) {
  const { tone, icon } = taskLook(task);
  return <Icon name={icon} className={cn(TONE[tone], className)} {...props} />;
}

/** A Task as icon and word; only your turn is said in its colour. */
export function TaskLabel({ task, className }: { task: LookTask; className?: string }) {
  const { word, turn } = useTaskLook(task);
  return (
    <span className={cn("inline-flex flex-none items-center gap-1 text-xs whitespace-nowrap", turn ? TONE.turn : TONE.quiet, className)}>
      <TaskIcon task={task} className="size-3" />
      {word}
    </span>
  );
}
