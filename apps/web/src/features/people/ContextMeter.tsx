import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContextView } from "@alpacawork/contract/agent-context";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TONE_TEXT, UsageRing, percentText } from "@/components/ui/usage-ring";
import { compactionCut, contextFigure, type TaskConversations } from "@/domain/context";
import { limitTone } from "@/domain/limits";
import { contextPercent } from "@alpacawork/contract/agent-context";
import { Icon } from "@/components/ui/icon";
import { tokenText } from "@/domain/tokens";
import { LOST_IN_CONVERSATION } from "@/features/reader/ConversationDetail";
import { cn } from "@/lib/utils";

/* Hallmark · component: context meter · genre: modern-minimal · theme: the app's own tokens (the usage ring) */

/**
 * How full a working agent's conversation is, at the end of its line: a ring and the percent (the tokens when its agent
 * names no window, "—" just after a compaction). `press`: a press opens the tokens used and the window and, with
 * `conversations`, the Task's conversation changes by time (ConversationList); on a line that is itself pressed (a
 * child's), the figures are its tooltip instead.
 */
export function ContextMeter({ context, press, conversations }: { context: ContextView; press: boolean; conversations?: TaskConversations }) {
  const { t, i18n } = useTranslation("people");
  const [open, setOpen] = useState(false);
  const figure = contextFigure(context);
  const count = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const compact = tokenText;
  const shown = figure.waiting ? "—" : figure.percent !== null ? percentText(figure.percent) : compact(context.usedTokens!);
  const used = figure.waiting ? t("context.waiting") : t("context.tokens", { count: context.usedTokens!, tokens: count(context.usedTokens!) });
  const window = context.windowTokens === null ? t("context.noWindow") : t("context.tokens", { count: context.windowTokens, tokens: count(context.windowTokens) });
  const label = t("context.label", { figure: shown, used, window });
  const face = <>
    <UsageRing percent={figure.percent ?? 0} tone={figure.tone} open={figure.open} className="size-3.5" />
    <span className={cn("min-w-[4ch] text-right tabular-nums", figure.percent === null ? "text-muted" : TONE_TEXT[figure.tone])}>{shown}</span>
  </>;
  if (!press) return <span data-context-meter title={label} aria-label={label} className="inline-flex items-center gap-1 text-xs">{face}</span>;
  // The line under it opens and closes on a press: the meter's own press stops there. Its hover and touch room reach
  // past its face (negative margins), so the figure stands where an unpressable meter's would.
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger data-context-meter aria-label={label} title={label} onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      className="relative z-1 -mx-1 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 text-xs outline-none pointer-fine:hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/40 narrow:-my-3.5 narrow:min-h-11">
      {face}
    </PopoverTrigger>
    <PopoverContent align="end" className={cn("p-3 text-sm", conversations?.changes.length ? "w-80" : "w-64")} onClick={event => event.stopPropagation()}>
      <p className="m-0 text-xs font-medium text-muted">{t("context.title")}{figure.percent !== null && ` ${percentText(figure.percent)}`}</p>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1">
        <dt className="text-muted">{t("context.used")}</dt><dd className="m-0 text-right tabular-nums">{used}</dd>
        <dt className="text-muted">{t("context.window")}</dt><dd className="m-0 text-right tabular-nums">{window}</dd>
      </dl>
      {figure.waiting && <p className="m-0 mt-2 text-xs text-muted">{t("context.compacted")}</p>}
      {figure.open && <p className="m-0 mt-2 text-xs text-muted">{t("context.setWindow")}</p>}
      {conversations && conversations.changes.length > 0 && <ConversationList conversations={conversations} />}
    </PopoverContent>
  </Popover>;
}

/**
 * A Task's conversations by time, newest first: each new conversation with why, each compaction with its fill before and
 * after and what it took out, and above them what the compactions took out together. A ? beside the heading opens, on a
 * press, what new conversations and compactions are.
 */
function ConversationList({ conversations }: { conversations: TaskConversations }) {
  const { t, i18n } = useTranslation("people");
  const compact = tokenText;
  // Times in one form down the list, so the rows line up: with the date once any of them is not today's.
  const today = new Date().toDateString();
  const dated = conversations.changes.some(change => new Date(change.at).toDateString() !== today);
  const clock = new Intl.DateTimeFormat(i18n.language, dated ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit" });
  const when = (at: string) => clock.format(new Date(at));
  const fill = (tokens: number, window: number | null) => {
    const percent = window ? contextPercent({ usedTokens: tokens, windowTokens: window })! : null;
    return <span className="inline-flex items-center gap-0.5">
      <UsageRing percent={percent ?? 0} tone={limitTone(percent ?? 0)} open={percent === null} className="size-3" />{percent !== null ? percentText(percent) : compact(tokens)}</span>;
  };
  const total = conversations.cutTokens, more = conversations.anew + conversations.compacted - conversations.changes.length;
  return <div data-conversation-list className="mt-2 border-t border-rule pt-2 text-xs">
    <div className="flex items-center gap-1">
      <p className="m-0 font-medium text-muted">{t("context.conversations")}</p>
      <Popover>
        <PopoverTrigger aria-label={t("context.help")} onClick={event => event.stopPropagation()}
          className="relative inline-flex size-5 cursor-pointer before:absolute before:-inset-3 before:content-[''] items-center justify-center rounded-full text-muted outline-none pointer-fine:hover:bg-hover pointer-fine:hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/40">
          <Icon name="help" className="size-4" /></PopoverTrigger>
        <PopoverContent side="top" className="w-64 p-3 text-xs" onClick={event => event.stopPropagation()}>
          {/* Each term with the mark it has in the list and History, then what the list's figures are. */}
          <dl data-conversation-help className="m-0 grid gap-2">
            <div><dt className="flex items-center gap-1 font-medium"><Icon name="reload" className="size-3.5 text-conversation" />{t("context.change.compacted")}</dt>
              <dd className="m-0 mt-0.5">{t("context.helpCompacted")}</dd></div>
            <div><dt className="flex items-center gap-1 font-medium"><Icon name="chat" className="size-3.5 text-conversation" />{t("context.change.new")}</dt>
              <dd className="m-0 mt-0.5">{t("context.helpNew")}{" "}
                <a href={LOST_IN_CONVERSATION} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">{t("context.source")}</a></dd></div>
          </dl>
          <p className="m-0 mt-2 border-t border-rule pt-2 text-muted">{t("context.helpFigures")}</p></PopoverContent>
      </Popover>
    </div>
    {/* What the compactions took out, the one figure that says what they were worth, read first. */}
    {total !== null && <div data-conversation-cut className="mt-2">
      <p className="m-0 text-muted">{t("context.cutLabel")}</p>
      <p className="m-0 text-lg font-semibold tabular-nums">{t("context.cutTokens", { tokens: compact(total) })}</p></div>}
    <ol className="m-0 mt-2 max-h-48 list-none overflow-y-auto p-0">
      {[...conversations.changes].reverse().map((change, index) => {
        const cut = compactionCut(change);
        return <li key={index} data-conversation-change={change.change} className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 py-1 tabular-nums">
          <span className="text-muted">{when(change.at)}</span>
          <Icon name={change.change === "new" ? "chat" : "reload"} className="size-3.5 text-conversation" />
          {change.change === "new"
            ? <span className="min-w-0 truncate">{t("context.change.new")}{change.because && <span className="text-muted"> · {{ handoff: t("context.because.handoff"), asked: t("context.because.asked"),
              another_ai: t("context.because.another_ai"), unresumable: t("context.because.unresumable") }[change.because]}</span>}</span>
            : <span className="inline-flex min-w-0 items-center gap-1">{t("context.change.compacted")}{change.beforeTokens !== null && change.afterTokens !== null &&
              <span className="inline-flex items-center gap-1 text-muted">{fill(change.beforeTokens, change.windowTokens)}<Icon name="arrowRight" className="size-3" />{fill(change.afterTokens, change.windowTokens)}</span>}</span>}
          <span className="text-right text-muted">{cut !== null ? `−${compact(cut)}` : ""}</span>
        </li>;
      })}
    </ol>
    {more > 0 && <p data-conversation-more className="m-0 mt-1 text-muted">{t("context.more", { count: more })}</p>}
  </div>;
}
