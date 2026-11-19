import { useTranslation } from "react-i18next";
import { ExampleList } from "@/components/ui/example-list";
import { TimelineMark } from "@/components/ui/timeline-mark";
import { cn } from "@/lib/utils";
import { AppHint } from "./app-hint";
import { exampleInDraft } from "./editor/draft";
import { UnreadMark } from "./unread-mark";

export type Warm = "preparing" | "ready" | "failed";
/** A mark standing on the rail: on a disc of the rail's ground, so the rail stops at it (as TimelineMark's). */
const ON_DISC = "rounded-full bg-lit ring-2 ring-lit";

function useWarmWords(warm: Warm) {
  const { t } = useTranslation("ui");
  const words = { preparing: t("coordinatorCard.warm.preparing"), ready: t("coordinatorCard.warm.ready"), failed: t("coordinatorCard.warm.failed") };
  // Each example's row says it short; it puts fuller words in the input. Written out for the extractor.
  const examples = [
    { name: "turn", label: t("coordinatorCard.warm.examples.turn.label"), words: t("coordinatorCard.warm.examples.turn.words") },
    { name: "research", label: t("coordinatorCard.warm.examples.research.label"), words: t("coordinatorCard.warm.examples.research.words") },
    { name: "steer", label: t("coordinatorCard.warm.examples.steer.label"), words: t("coordinatorCard.warm.examples.steer.words") },
    { name: "policy", label: t("coordinatorCard.warm.examples.policy.label"), words: t("coordinatorCard.warm.examples.policy.words") },
  ];
  return { said: words[warm], examples };
}
function Mark({ warm, className }: { warm: Warm; className?: string }) {
  return warm === "ready" ? <UnreadMark className={cn(ON_DISC, className)} />
    : <TimelineMark kind={warm === "preparing" ? "start" : "error"} tone={warm === "preparing" ? "working" : "error"} live={warm === "preparing"} className={className} />;
}
/** The greeting, or how far the coordinator has got: said to assistive technology as it changes, a heading still. */
function Said({ warm, said, className }: { warm: Warm; said: string; className?: string }) {
  return <div role="status" className={cn("flex items-center gap-2.5", className)}>
    <Mark warm={warm} className="size-4.5 flex-none" />
    <h2 className={cn("m-0 text-lg font-semibold text-ink [word-break:auto-phrase] narrow:text-md", warm === "preparing" && "text-muted", warm === "failed" && "text-error")}>{said}</h2>
  </div>;
}
/**
 * A conversation with no message yet: how far the coordinator has got ready and examples to start from,
 * as the empty list's (Welcome): a heading and the examples on their own surface (ExampleList), in a column in the middle of the
 * conversation both ways, so a cleared conversation is never a small line in its corner. The rows only fill the input;
 * the person sends. Failed to start, it says so in the same place and offers no examples. The examples are the same
 * whatever the list shows: the conversation opens over the list, so it never leaves them to the list. Under the
 * examples, the first time, the pointer to the phone and app guide (AppHint).
 */
export function WarmStart({ warm }: { warm: Warm }) {
  const { said, examples } = useWarmWords(warm);
  // 100cqh: the conversation's scrolling area, a size container while this is in it (CoordinatorCard), less its head
  // (--pane-head) and 20px, a little more than the list's own 12px round it, so it fills the area without scrolling.
  return <li data-coordinator-warm={warm} className="flex min-h-[calc(100cqh-var(--pane-head,1.25rem)-1.25rem)] animate-rise items-center justify-center py-4">
    <div className="w-[min(100%,26rem)]">
      <Said warm={warm} said={said} className="mb-3" />
      {warm !== "failed" && <>
        <ExampleList examples={examples} mark="data-warm-example" onPick={words => exampleInDraft(words, null)} />
        <AppHint />
      </>}
    </div>
  </li>;
}
