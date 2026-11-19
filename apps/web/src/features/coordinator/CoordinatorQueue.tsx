import { MessageDelivery } from './MessageDelivery';
export { rowControl } from './delivery-presentation';
import { ReplyLabel } from './ReplyLabel';
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useShownConversation, type LocalTurn, type SentTurn } from "./shown";
import { MessageFiles, messageMedia, type OpenMessageImages } from "./MessageFiles";
import { MediaThumb } from "@/features/reader/TaskMedia";

function WaitingMessage({ turn, local, index, open }: {
  turn: SentTurn; local?: LocalTurn; index: number; open: OpenMessageImages;
}) {
  const [expanded, setExpanded] = useState(false);
  const media = messageMedia(turn)[0];
  return <li data-coordinator-waiting={turn.id} data-coordinator-local={local?.stage} className="flex items-start gap-2 border-t border-rule pr-1 pl-2">
    <span className="w-3 flex-none pt-1.5 text-center text-xs tabular-nums text-muted narrow:pt-3">{index + 1}</span>
    <MessageDelivery turn={turn} local={local} panel>
      {/* Its label comes first, as in a sent message. Not drawn in the conversation yet, the way back is to the input. */}
      {turn.replyTo && <div className="pt-1 narrow:pt-2.5"><ReplyLabel reply={turn.replyTo} origin={{ at: turn.at }} /></div>}
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        className="flex min-h-7 w-full min-w-0 items-center gap-1.5 py-1 text-left narrow:min-h-11">
        {!expanded && media && <MediaThumb name={media.path} src={media.src} badge={false} className="size-5 flex-none rounded-xs border border-line" />}
        <span className={cn("min-w-0", expanded ? "whitespace-pre-wrap wrap-anywhere" : "truncate")}>{turn.ask || turn.attachments.join(", ")}</span>
      </button>
      {expanded && !!turn.attachments.length && <div className="pb-1.5"><MessageFiles turn={turn} open={open} all /></div>}
    </MessageDelivery>
  </li>;
}

/** Both queue surfaces consume the one partition in shown.tsx. Queued alone does not mean waiting. */
export function useWaiting() {
  const shown = useShownConversation();
  const waiting = shown.waiting;
  const running = shown.thread.some(turn => turn.status === "running");
  // Sent from here behind work under way: it waits here from the press, as serve will queue it.
  const local = shown.localWaiting;
  return { waiting, local, running, count: waiting.length + local.length };
}
export type Waiting = ReturnType<typeof useWaiting>;

/** The waiting messages in the order they go, each with its own moves (withdraw, send now). */
export function WaitingRows({ queue, open, className }: { queue: Waiting; open: OpenMessageImages; className?: string }) {
  const { t } = useTranslation("ui");
  const { waiting, local } = queue;
  const { closing } = useShownConversation();
  const rows = waiting.map((turn, index) => <WaitingMessage key={turn.id} turn={turn} index={index} open={open} />);
  local.forEach((turn, index) => rows.push(<WaitingMessage key={`local:${turn.id}`} turn={turn} local={turn} index={waiting.length + index} open={open} />));
  return <ol data-action-focus-scope tabIndex={-1} inert={closing} aria-busy={closing || undefined} aria-label={t("coordinatorCard.waitingMessages")} className={cn("m-0 list-none", closing && 'opacity-60', className)}>
    {rows}
  </ol>;
}
