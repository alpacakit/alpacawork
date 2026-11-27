/* Hallmark · component: coordinator reset line · genre: modern-minimal (utilitarian) · theme: the app's tokens
 * states: default · memo open (reading · read · none · failed)
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { ON_DISC, ON_RAIL } from "@/components/ui/timeline-mark";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { readResetMemo, type CoordinatorReset } from "@/data/coordinator";
import { recordFailure } from "@/lib/notify";
import { messageTime } from "./message-time";
import { resetReason } from "./reset-words";

type Memo = { state: "reading" } | { state: "read"; memo: { text: string; updatedAt: string } | null } | { state: "failed" };

/**
 * Where the coordinator started again in the conversation, whatever started it (a press, its usage, another AI): a row
 * of the thread as the earlier messages' row is (its mark on the rail, its words from the left), with why (none when
 * the person asked) and the memo it was handed, read when opened. Wrapped, it still reads as one sentence.
 */
export function ResetLine({ reset }: { reset: CoordinatorReset }) {
  const { t } = useTranslation("ui");
  const reason = resetReason(reset.reason, t);
  return <li data-coordinator-reset-line={reset.reason.kind} className="relative flex min-h-11 items-center border-b border-rule py-2 pl-(--gutter)">
    <span className="relative flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted">
      {/* The mark hangs on the rail from a strut as high as the first line's capitals, so it centres on them. */}
      <span className="relative -mr-2 cap-strut"><span className={`${ON_RAIL} -ml-(--gutter) top-1/2 flex -translate-y-1/2`}><Icon name="reload" className={`size-3.5 ${ON_DISC}`} /></span></span>
      <span>{t("coordinatorCard.reset.done")}{reason && <> · {reason}</>}</span>
      <MemoLink reset={reset} />
    </span>
  </li>;
}

/** The memo handed over, read once its line asks for it: as it was at the reset, with when it was last written. */
function MemoLink({ reset }: { reset: CoordinatorReset }) {
  const { t, i18n } = useTranslation("ui");
  const [memo, setMemo] = useState<Memo | null>(null);
  const read = () => {
    if (memo?.state === "reading" || memo?.state === "read") return;
    setMemo({ state: "reading" });
    readResetMemo(reset.id).then(value => setMemo({ state: "read", memo: value }), error => { recordFailure(error, "coordinator reset memo"); setMemo({ state: "failed" }); });
  };
  return <Popover onOpenChange={open => { if (open) read(); }}>
    {/* Its press reaches 12px past its words, so a finger finds it without the row growing. */}
    <PopoverTrigger data-coordinator-reset-memo className="relative cursor-pointer whitespace-nowrap rounded-sm text-ink underline decoration-line underline-offset-3 outline-none before:absolute before:-inset-3 before:content-[''] hover:decoration-ink focus-visible:ring-2 focus-visible:ring-ink/40">
      {t("coordinatorCard.reset.memo")}
    </PopoverTrigger>
    <PopoverContent data-coordinator-reset-memo-text side="bottom" align="start" collisionPadding={8} className="w-[min(32rem,calc(100vw-1rem))] p-3 text-sm">
      {memo?.state === "read" && memo.memo ? <>
        <p className="m-0 text-xs text-muted">{t("coordinatorCard.reset.memoTitle", { time: messageTime(memo.memo.updatedAt, i18n.language) })}</p>
        <p className="m-0 mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{memo.memo.text}</p>
        <p className="m-0 mt-2 text-xs text-muted">{t("coordinatorCard.reset.memoAfter")}</p>
      </> : <p role="status" className="m-0 text-muted">{memo?.state === "failed" ? t("coordinatorCard.reset.memoFailed")
        : memo?.state === "read" ? t("coordinatorCard.reset.memoNone") : t("coordinatorCard.reset.memoReading")}</p>}
    </PopoverContent>
  </Popover>;
}
