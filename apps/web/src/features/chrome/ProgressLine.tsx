import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUpdateSwitching } from "@/features/update/update-state";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useConnection } from "@/data/connection";
import { useOfflineShown } from "@/data/reach";
import { notify } from "@/lib/notify";

/**
 * The feed's state as one thin line at the very top of the screen, above the bar whether it is shown or hidden.
 * Opening a subscription (the page opening, a pull to refresh, a return to the page) flows along a faint track; out of
 * reach (`useOfflineShown`, never a subscription still opening) the line stands still in grey for as long as it
 * lasts, so the screen says it is not kept up to date wherever one looks, with or without anything read yet; going live
 * fills the line once and lets it go. What each phase draws is `LOOK`, and nowhere else.
 *
 * No words stay on screen for it: the bar's offline mark explains it and reconnects. The moment it goes out of reach a
 * toast says so once (an info, which goes by itself: the mark and the line say it meanwhile), and going live takes that
 * toast away. Retrying goes on meanwhile.
 */
type Phase = "idle" | "loading" | "offline" | "done" | "back" | "leaving";
const LOOK: Record<Phase, "none" | "flow" | "still" | "fill" | "leave"> = {
  idle: "none",
  loading: "flow",
  offline: "still",
  // Live again: `back` after being out of reach, `done` after a load.
  done: "fill",
  back: "fill",
  // A place's read again over: the flowing line fades where it stands.
  leaving: "leave",
};
const FLOW = cn("w-2/5 animate-progress-flow bg-[linear-gradient(90deg,transparent,currentColor_35%,currentColor_65%,transparent)]",
  "motion-reduce:w-full motion-reduce:bg-none motion-reduce:bg-progress-track");
const LOOK_CLASS = {
  flow: FLOW,
  still: "w-full bg-current",
  fill: "w-full origin-left animate-progress-fill bg-current",
  leave: FLOW,
};
/** The toast slot of the moment the screen went out of reach. */
export const OFFLINE_TOAST = "offline";
/** How long "Updates resumed" stays for a screen reader to say, whatever the fill's length (reduced motion: none). */
const BACK_SAID_MS = 4000;

export function ProgressLine() {
  const { t } = useTranslation("chrome");
  const offline = useOfflineShown();
  const live = useConnection((connection) => connection.state === "live");
  const now: Phase = live ? "idle" : offline ? "offline" : "loading";
  const switching = useUpdateSwitching();
  // Going live from another phase fills the line once; its animation's end lets it go.
  const [phase, setPhase] = useState<Phase>(now);
  const [backSaid, setBackSaid] = useState(false);
  const troubled = useRef(false);
  useLayoutEffect(() => {
    // The shared display predicate also ends an observation when the page goes away. Retire its notice before paint,
    // even while the next foreground connection is still being checked; a later real failure is a new notification.
    // Known only later to be a switch: the notice already shown goes too.
    if (now !== "offline" || switching) notify.dismiss(OFFLINE_TOAST);
    if (now !== "idle") {
      // An update's switch restarts the serve: out of reach meanwhile is expected and its line says so; no notice then.
      if (now === "offline" && !troubled.current && !switching) { troubled.current = true; notify.info(t("translation:offline.toast"), { id: OFFLINE_TOAST }); }
      if (now === "loading") troubled.current = false;
      setPhase(now); setBackSaid(false); return;
    }
    const end = troubled.current ? "back" : "done";
    troubled.current = false;
    setPhase((was) => was === "idle" ? "idle" : end);
    if (end !== "back") return;
    setBackSaid(true);
    const timer = setTimeout(() => setBackSaid(false), BACK_SAID_MS);
    return () => clearTimeout(timer);
  }, [now, t, switching]);
  return <>
    <Line phase={phase} name="progress-line" onEnded={() => setPhase("idle")} className="fixed inset-x-0 top-0 z-(--layer-progress)" />
    {/* The end, for a screen reader: the toast already said the start. */}
    <p role="status" className="sr-only">{backSaid ? t("notice.back") : ""}</p>
  </>;
}

/** A read again shows once it has lasted this long: a shorter one is over before a person waits for it. */
export const READING_SHOWN_AFTER_MS = 1000;
/** A line shown stays this long after a slow read ends, so slow reads that follow one another are one wait. */
export const READING_HELD_MS = 1500;

/**
 * A place being read again shows it with the same line, at its own edge (the reader under its head), only while a
 * person waits for it: it flows once a read has lasted `READING_SHOWN_AFTER_MS`, stays `READING_HELD_MS` past the end of
 * the last read that lasted that long (and through a read under way when that runs out, until it proves quick), then
 * fades. Quick reads neither show it nor keep it: what is shown is current meanwhile. Drawn only over what was read: a
 * placeholder says its own wait.
 */
export function ReadingLine({ reading, className }: { reading: boolean; className?: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  // The read under way (`active`) has lasted the wait (`slow`); the hold ran out during it (`due`).
  const active = useRef(false), slow = useRef(false), due = useRef(false);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const leave = () => setPhase((was) => was === "loading" ? "leaving" : was);
    active.current = reading;
    if (reading) {
      slow.current = false;
      const shown = setTimeout(() => { slow.current = true; due.current = false; clearTimeout(hold.current); setPhase("loading"); }, READING_SHOWN_AFTER_MS);
      return () => clearTimeout(shown);
    }
    // A slow read holds the line; a quick one only ends a hold that ran out while it was under way.
    if (slow.current) {
      slow.current = false;
      hold.current = setTimeout(() => { if (active.current) due.current = true; else leave(); }, READING_HELD_MS);
    } else if (due.current) { due.current = false; leave(); }
  }, [reading]);
  useEffect(() => () => clearTimeout(hold.current), []);
  return <Line phase={phase} name="reading-line" onEnded={() => setPhase((was) => was === "leaving" ? "idle" : was)} className={className} />;
}

/** The line as `phase` draws it (LOOK), marked `data-<name>` with its phase; a fill or a leave ends by calling `onEnded`. */
function Line({ phase, name, onEnded, className }: { phase: Phase; name: string; onEnded: () => void; className?: string }) {
  const look = LOOK[phase];
  if (look === "none") return null;
  return <div aria-hidden="true" {...{ [`data-${name}`]: phase }} className={cn("pointer-events-none", className)}>
    <div className={cn("overflow-hidden", phase === "offline" ? "h-1 text-muted" : "h-0.75 text-working", (look === "flow" || look === "leave") && "bg-progress-track",
      look === "leave" && "animate-progress-leave")} onAnimationEnd={() => { if (look === "fill" || look === "leave") onEnded(); }}>
      <div className={cn("h-full", LOOK_CLASS[look])} />
    </div>
  </div>;
}
