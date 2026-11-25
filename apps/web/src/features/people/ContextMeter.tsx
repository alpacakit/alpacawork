import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContextView } from "@alpacawork/contract/agent-context";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TONE_TEXT, UsageRing, percentText } from "@/components/ui/usage-ring";
import { contextFigure, type ConversationCounts } from "@/domain/context";
import { cn } from "@/lib/utils";

/* Hallmark · component: context meter · genre: modern-minimal · theme: the app's own tokens (the usage ring) */

/**
 * How full a working agent's conversation is, at the end of its line: a ring and the percent (the tokens when its agent
 * names no window, "—" just after a compaction). `press`: a press opens the tokens used and the window, how the
 * conversation is kept workable (compacted near its limit, started anew with the Task's records) and, with
 * `conversations`, how often that happened on the Task; on a line that is itself pressed (a child's), the figures are
 * its tooltip instead.
 */
export function ContextMeter({ context, press, conversations }: { context: ContextView; press: boolean; conversations?: ConversationCounts }) {
  const { t, i18n } = useTranslation("people");
  const [open, setOpen] = useState(false);
  const figure = contextFigure(context);
  const count = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const compact = (value: number) => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
    <PopoverContent align="end" className="w-64 p-3 text-sm" onClick={event => event.stopPropagation()}>
      <p className="m-0 text-xs font-medium text-muted">{t("context.title")}{figure.percent !== null && ` ${percentText(figure.percent)}`}</p>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-5 gap-y-1">
        <dt className="text-muted">{t("context.used")}</dt><dd className="m-0 text-right tabular-nums">{used}</dd>
        <dt className="text-muted">{t("context.window")}</dt><dd className="m-0 text-right tabular-nums">{window}</dd>
      </dl>
      {figure.waiting && <p className="m-0 mt-2 text-xs text-muted">{t("context.compacted")}</p>}
      {figure.open && <p className="m-0 mt-2 text-xs text-muted">{t("context.setWindow")}</p>}
      {/* How the conversation is kept workable, said where its fill is read; and how often it happened on this Task. */}
      <p className="m-0 mt-3 text-xs text-muted">{t("context.kept")}</p>
      {conversations && <p data-conversation-counts className="m-0 mt-2 text-xs">{t("context.counts", {
        anew: t("context.anew", { count: conversations.anew }), compacted: t("context.compactions", { count: conversations.compacted }) })}</p>}
    </PopoverContent>
  </Popover>;
}
