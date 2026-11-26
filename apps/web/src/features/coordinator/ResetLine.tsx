/* Hallmark · component: coordinator reset line · genre: modern-minimal (utilitarian) · theme: the app's tokens
 * states: default · memo open (reading · read · none · failed)
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { readResetMemo, type CoordinatorReset } from "@/data/coordinator";
import { recordFailure } from "@/lib/notify";
import { messageTime } from "./message-time";
import { resetReason } from "./reset-words";

type Memo = { state: "reading" } | { state: "read"; memo: { text: string; updatedAt: string } | null } | { state: "failed" };

/**
 * Where the coordinator started again in the conversation, whatever started it (a press, its usage, another AI): one
 * line across the thread, with why (none when the person asked) and the memo it was handed, read when opened.
 */
export function ResetLine({ reset }: { reset: CoordinatorReset }) {
  const { t } = useTranslation("ui");
  const reason = resetReason(reset.reason, t);
  return <li data-coordinator-reset-line={reset.reason.kind} className="relative flex items-center gap-3 py-2 text-xs text-muted before:h-px before:min-w-4 before:flex-1 before:bg-rule after:h-px after:min-w-4 after:flex-1 after:bg-rule">
    <span className="flex min-w-0 max-w-[calc(100%-4rem)] flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Icon name="reload" className="size-3.5 flex-none" />
        <span>{t("coordinatorCard.reset.done")}{reason && <> · {reason}</>}</span>
      </span>
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
    <PopoverTrigger data-coordinator-reset-memo className="cursor-pointer whitespace-nowrap rounded-sm text-ink underline decoration-line underline-offset-3 outline-none hover:decoration-ink focus-visible:ring-2 focus-visible:ring-ink/40 narrow:min-h-11">
      {t("coordinatorCard.reset.memo")}
    </PopoverTrigger>
    <PopoverContent data-coordinator-reset-memo-text side="bottom" align="center" collisionPadding={8} className="w-[min(32rem,calc(100vw-1rem))] p-3 text-sm">
      {memo?.state === "read" && memo.memo ? <>
        <p className="m-0 text-xs text-muted">{t("coordinatorCard.reset.memoTitle", { time: messageTime(memo.memo.updatedAt, i18n.language) })}</p>
        <p className="m-0 mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{memo.memo.text}</p>
        <p className="m-0 mt-2 text-xs text-muted">{t("coordinatorCard.reset.memoAfter")}</p>
      </> : <p role="status" className="m-0 text-muted">{memo?.state === "failed" ? t("coordinatorCard.reset.memoFailed")
        : memo?.state === "read" ? t("coordinatorCard.reset.memoNone") : t("coordinatorCard.reset.memoReading")}</p>}
    </PopoverContent>
  </Popover>;
}
