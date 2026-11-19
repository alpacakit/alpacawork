import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Icon, type IconName } from "./icon";
import { cn } from "@/lib/utils";

/**
 * What a message is about, said by one icon and colour everywhere:
 *   error    something failed (a read, a save): the warning colour, a ring with "!"
 *   caution  something to heed before going on, or a part of the screen that cannot work: the warning colour, a triangle
 *   info     something to know, nothing failed (the version changed, not kept on this device): muted, a ring with "i"
 *   empty    nothing to show here yet: muted, the place's own icon (an open tray by default)
 *   waiting  under way, it comes back by itself: muted, a turning ring
 */
export type MessageTone = "error" | "caution" | "info" | "empty" | "waiting";
const LOOK: Record<MessageTone, { icon: IconName; color: string }> = {
  error: { icon: "error", color: "text-warn" },
  caution: { icon: "caution", color: "text-warn" },
  info: { icon: "info", color: "text-muted" },
  empty: { icon: "empty", color: "text-muted" },
  waiting: { icon: "pending", color: "text-muted" },
};

/**
 * Where it stands; the words and the press are the same in each, only their arrangement changes:
 *   page    the whole page is this message, centred (the workspace could not be shown)
 *   region  in place of a panel's or a list's content, centred in it (nothing found, a panel that could not be read)
 *   line    one row among other content (the end of a list whose next page failed, what is not kept on this device)
 *   band    a note set apart in a square-cornered box beside what it is about (what a final button will do, a notice over the list)
 */
export type MessageSize = "page" | "region" | "line" | "band";
/** A press; what it returns, if a promise, keeps the button turning until it settles (else a moment, so the press is felt). */
export type MessageAction = { label: string; run: () => unknown; icon?: IconName; disabled?: boolean;
  /** What it started is still under way elsewhere (an update's answer being sent): turning and not pressed, focus kept. */
  busy?: boolean;
  /** The press's own marks, for what finds it (`data-archive-restore`). */
  data?: { [key: `data-${string}`]: string } };

const FELT_MS = 800;
/** A press, turning while what it started runs, and not pressed again meanwhile. */
function ActionButton({ action, size, variant }: { action: MessageAction; size: MessageSize; variant: "default" | "outline" }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const press = () => {
    if (busy || action.busy) return;
    setBusy(true);
    const started = Date.now();
    // Run in the press itself (a dialog it opens opens now); only its settling is waited for.
    let result: unknown;
    try { result = action.run(); } catch (error) { setBusy(false); throw error; }
    void Promise.resolve(result).catch(() => undefined).then(() =>
      setTimeout(() => { if (alive.current) setBusy(false); }, Math.max(0, FELT_MS - (Date.now() - started))));
  };
  return <Button type="button" {...action.data} data-message-action={variant === "default" ? "main" : "second"} variant={variant} disabled={action.disabled}
    aria-disabled={busy || action.busy || undefined} onClick={press}
    className={cn("max-w-full whitespace-normal text-center [overflow-wrap:anywhere] aria-disabled:cursor-default", size === "page" || size === "region" ? "min-h-10 px-4 text-base narrow:min-h-11" : "narrow:min-h-11")}>
    {busy || action.busy ? <Icon name="pending" className="size-3.5 animate-spin" /> : action.icon && <Icon name={action.icon} className="size-3.5" />}{action.label}
  </Button>;
}

/**
 * The one way the screen says what happened in a place and what to do next: a heading (what happened), a description
 * (why, or what comes next), and at most one main press with an optional second. Every full-page state, failed read,
 * empty list, notice and caution draws through this, so they look and line up alike; a place gives its words, never its
 * own look. A failure is an alert; a state that comes and goes (`live`) is said politely; a band or line that only stands
 * there is read in place.
 */
export function Message({ tone, size = "region", title, description, action, secondary, icon, className, live, quiet, ...data }: {
  tone: MessageTone; size?: MessageSize; title: ReactNode; description?: ReactNode;
  action?: MessageAction; secondary?: MessageAction; icon?: IconName; className?: string;
  /** Said to a screen reader as it changes (a state that comes and goes), rather than once as an alert. */
  live?: boolean;
  /** Read in place, never announced: one of a list of facts shown as a dialog opens (diagnostics' unreadable files). */
  quiet?: boolean;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const look = LOOK[tone];
  const role = quiet ? undefined : live ? "status" : tone === "error" ? "alert" : size === "page" || size === "region" ? "status" : undefined;
  const block = size === "page" || size === "region";
  const mark = <Icon name={icon ?? look.icon} aria-hidden="true"
    className={cn("flex-none", look.color, tone === "waiting" && "animate-spin [animation-duration:1.4s]", size === "page" ? "size-7" : block ? "size-5" : "size-4")} />;
  const buttons = (action || secondary) && <div className={cn("flex flex-wrap gap-2", block && "justify-center")}>
    {action && <ActionButton action={action} size={size} variant={block ? "default" : "outline"} />}
    {secondary && <ActionButton action={secondary} size={size} variant="outline" />}
  </div>;
  const common = { ...data, role, "aria-live": live ? "polite" as const : undefined, "data-message": tone, "data-message-size": size };
  if (!block) return <div {...common} className={cn("flex min-w-0 flex-wrap items-start gap-x-2.5 gap-y-2 text-sm",
      size === "band" && "border border-line bg-[color:color-mix(in_oklab,var(--ink)_4%,transparent)] px-3 py-2", className)}>
    <span className="mt-0.5 flex">{mark}</span>
    <div className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
      <span className="text-ink">{title}</span>
      {description && (typeof description === "string" ? <span className="text-muted"> {description}</span> : <div className="mt-1 text-muted">{description}</div>)}
    </div>
    {buttons}
  </div>;
  return <div {...common} className={cn("mx-auto flex w-full min-w-0 flex-col items-center gap-4 text-center",
      size === "page" ? "max-w-md" : "max-w-sm py-8", className)}>
    <span className={cn("grid place-items-center rounded-full bg-lit", size === "page" ? "size-14" : "size-10")}>{mark}</span>
    <div className="flex min-w-0 flex-col gap-1">
      {size === "page" ? <h2 className="m-0 text-lg font-semibold text-ink [overflow-wrap:anywhere] [word-break:auto-phrase]">{title}</h2>
        : <p className="m-0 text-md font-medium text-ink [overflow-wrap:anywhere] [word-break:auto-phrase]">{title}</p>}
      {description && <div className={cn("m-0 text-muted [overflow-wrap:anywhere] [word-break:auto-phrase]", size === "page" ? "text-base" : "text-sm")}>{description}</div>}
    </div>
    {buttons}
  </div>;
}
