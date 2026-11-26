/* Hallmark · component: coordinator context · genre: modern-minimal (utilitarian) · theme: the app's tokens
 * states: default · hover · focus · open (the menu) · busy (Reset waits for the answer) · clear asking (second press)
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useWriteDisabled } from "@/data/queries";
import { recordFailure } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { countUse } from "@/features/telemetry/count";
import { ContextFace, ContextFigures, useContextWords } from "@/features/people/ContextMeter";
import { useConversation } from "./coordinator";
import { useShownConversation } from "./shown";
import { compactCount } from "./reset-words";

/**
 * How full the coordinator's own conversation is, left of its AI in the send row: the ring and figure every working
 * agent has. Pressed, it opens the figures, when it resets by itself, and the two ways to start the coordinator again:
 * Reset (the conversation stays, the AI starts over with its memo) and Clear conversation (all of it, pressed twice).
 * `className`: the row's own look for it (one of its quiet tools).
 */
export function CoordinatorContext({ className }: { className?: string }) {
  const { t } = useTranslation("ui");
  const conversation = useConversation(state => state.conversation);
  const shown = useShownConversation();
  const disabled = useWriteDisabled();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (!asking) return; const timer = setTimeout(() => setAsking(false), 4000); return () => clearTimeout(timer); }, [asking]);
  useEffect(() => { if (!open) setAsking(false); }, [open]);
  const context = conversation?.context ?? null;
  const words = useContextWords(context);
  if (!conversation) return null;
  // Reset waits for the answer at work (serve refuses it meanwhile): the coordinator starts again for the next message.
  const busy = conversation.busy;
  const auto = autoWords(t, conversation.autoReset);
  const reset = () => {
    setOpen(false);
    void shown.press(conversation.id, "reset", () => useConversation.getState().reset()).catch(error => recordFailure(error, "coordinator reset"));
  };
  const clear = (pressed: HTMLElement) => {
    if (!asking) { setAsking(true); return; }
    const surface = pressed.ownerDocument;
    setAsking(false); setOpen(false); countUse("coord.clear");
    // Emptied, the conversation is written to next: the input takes the focus the closing menu would give back (by the
    // press that cleared it; a press while it clears adds nothing).
    void shown.press(conversation.id, "clear", async () => {
      await useConversation.getState().clear();
      // After the closed menu has given the focus back to the ring, and the emptied conversation's input is drawn.
      setTimeout(() => surface.querySelector<HTMLElement>("[data-one-input]")?.focus({ preventScroll: true }));
    })
      .catch(error => recordFailure(error, "coordinator clear"));
  };
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger data-coordinator-context aria-label={`${t("coordinatorCard.context.tip")} ${words.label}`} title={t("coordinatorCard.context.tip")}
      className={cn("inline-flex flex-none cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ink/40", className)}>
      <ContextFace words={words} />
    </PopoverTrigger>
    <PopoverContent data-coordinator-context-menu side="top" align="end" collisionPadding={8} className="w-80 max-w-[calc(100vw-1rem)] p-0 text-sm">
      <div className="p-3">
        <p className="m-0 text-xs font-medium text-muted">{t("coordinatorCard.context.title")}{context && words.figure.percent !== null && ` ${words.shown}`}</p>
        {context ? <ContextFigures words={words} /> : <p className="m-0 mt-2 text-xs text-muted">{t("coordinatorCard.context.waiting")}</p>}
        {auto && <p data-coordinator-auto-reset className="m-0 mt-2 text-xs text-muted">{auto}</p>}
      </div>
      <div className="grid gap-0.5 border-t border-rule p-1.5">
        <MenuAction icon="reload" data-coordinator-reset disabled={disabled || busy || !!shown.closing} onPress={reset}
          name={t("coordinatorCard.reset.action")} about={busy ? t("coordinatorCard.reset.busy") : t("coordinatorCard.reset.about")} />
        <MenuAction icon="clear" data-coordinator-clear data-asking={asking || undefined} danger disabled={disabled || !!shown.closing} onPress={clear}
          name={asking ? t("coordinatorCard.clearConfirm") : t("coordinatorCard.clear")} about={t("coordinatorCard.clearAbout")} />
      </div>
    </PopoverContent>
  </Popover>;
}

/** One of the menu's two actions: its mark, its name, and under it what it does. */
function MenuAction({ icon, name, about, danger = false, disabled, onPress, ...data }: {
  icon: "reload" | "clear"; name: string; about: string; danger?: boolean; disabled: boolean; onPress: (pressed: HTMLElement) => void } & Record<`data-${string}`, unknown>) {
  return <button type="button" {...data} disabled={disabled} onClick={event => onPress(event.currentTarget)}
    className={cn("grid w-full cursor-pointer grid-cols-[auto_1fr] gap-x-2 rounded-sm px-1.5 py-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ink/40 disabled:cursor-default disabled:hover:bg-transparent",
      danger ? "text-error" : "text-ink", disabled && "[&>[data-name]]:text-muted [&>svg]:text-muted")}>
    <Icon name={icon} className="mt-0.5 size-4 flex-none" />
    <span data-name className="font-medium">{name}</span>
    <span className="col-start-2 text-xs text-muted">{about}</span>
  </button>;
}

/** When the coordinator resets by itself: the tokens, the share of its window, whichever comes first; none when off. */
function autoWords(t: (key: string, values?: Record<string, unknown>) => string, auto: { tokens: number; percent: number } | null | undefined) {
  if (!auto) return null;
  const tokens = auto.tokens > 0 ? compactCount(auto.tokens) : null, percent = auto.percent > 0 ? auto.percent : null;
  if (tokens && percent) return t("coordinatorCard.context.autoBoth", { tokens, percent });
  if (tokens) return t("coordinatorCard.context.autoTokens", { tokens });
  if (percent) return t("coordinatorCard.context.autoPercent", { percent });
  return null;
}
