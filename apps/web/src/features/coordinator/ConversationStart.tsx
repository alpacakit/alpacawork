import { useTranslation } from "react-i18next";
import { ExampleList } from "@/components/ui/example-list";
import { ON_DISC } from "@/components/ui/timeline-mark";
import { exampleInDraft } from "./editor/draft";
import { UnreadMark } from "./unread-mark";

/**
 * A conversation with no message yet: a greeting and examples to start from, the examples on their own surface
 * (ExampleList), in a column in the middle of the conversation both ways, so a cleared conversation is never a small
 * line in its corner. The rows only fill the input; the person sends. The examples are the same whatever the list
 * shows: the conversation opens over the list, so it never leaves them to the list.
 */
export function ConversationStart() {
  const { t } = useTranslation("ui");
  // Each example's row says it short; it puts fuller words in the input. Written out for the extractor.
  const examples = [
    { name: "turn", label: t("coordinatorCard.start.examples.turn.label"), words: t("coordinatorCard.start.examples.turn.words") },
    { name: "research", label: t("coordinatorCard.start.examples.research.label"), words: t("coordinatorCard.start.examples.research.words") },
    { name: "steer", label: t("coordinatorCard.start.examples.steer.label"), words: t("coordinatorCard.start.examples.steer.words") },
    { name: "policy", label: t("coordinatorCard.start.examples.policy.label"), words: t("coordinatorCard.start.examples.policy.words") },
  ];
  // 100cqh: the conversation's scrolling area, a size container while this is in it (CoordinatorCard), less its head
  // (--pane-head) and 20px, a little more than the list's own 12px round it, so it fills the area without scrolling.
  // py-4, not more: with four examples, more would make the conversation as it first opens on a computer (frame.ts
  // FIRST) scroll.
  return <li data-coordinator-start className="flex min-h-[calc(100cqh-var(--pane-head,1.25rem)-1.25rem)] animate-rise items-center justify-center py-4">
    <div className="w-[min(100%,26rem)]">
      <div className="mb-3 flex items-center gap-2.5">
        <UnreadMark className={`${ON_DISC} size-4.5 flex-none`} />
        <h2 className="m-0 text-lg font-semibold text-ink [word-break:auto-phrase] narrow:text-md">{t("coordinatorCard.start.greeting")}</h2>
      </div>
      <ExampleList examples={examples} onPick={words => exampleInDraft(words)} />
    </div>
  </li>;
}
