import { useTranslation } from "react-i18next";
import type { Task } from "@/data/types";
import { useOfflineShown } from "@/data/reach";
import { useSentMark, type SentMark } from "@/features/coordinator/sent-mark";
import { cn } from "@/lib/utils";

/**
 * A thin arc turning around the row's state icon while an instruction sent to this Task waits for its work to
 * start, or a state change sent to it waits to show (`useSentMark` decides when). Its parent is the icon's box, positioned. Out of reach it stands still in grey
 * (nothing unseen is shown as moving); with reduced motion `animate-spin` is none, so it stands still too.
 * `say: false` where the marks are hidden from readers; `SentWord` says it there instead.
 */
export function SentArc({ task, say = true }: { task: Pick<Task, "id" | "state" | "stateLog" | "rowFacts">; say?: boolean }) {
  const marked = useSentMark(task);
  const offline = useOfflineShown();
  if (!marked) return null;
  return <>
    {say && <SentWords marked={marked} />}
    <span data-sent-mark aria-hidden="true" className={cn("pointer-events-none absolute -inset-[3px] rounded-full border-[1.5px]",
      offline ? "border-muted/20 border-t-muted" : "animate-spin border-working/20 border-t-working")} />
  </>;
}

/** The arc's words for a reader, where the arc itself sits in marks hidden from readers (the phone row). */
export function SentWord({ task }: { task: Pick<Task, "id" | "state" | "stateLog" | "rowFacts"> }) {
  const marked = useSentMark(task);
  return marked ? <SentWords marked={marked} /> : null;
}

function SentWords({ marked }: { marked: SentMark }) {
  const { t } = useTranslation("tree");
  return <span className="sr-only">{marked === "state" ? t("sent.stateChange") : t("sent.pending")}</span>;
}
