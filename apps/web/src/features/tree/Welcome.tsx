import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { AppHint } from "@/features/coordinator/app-hint";
import { useGoingGuide } from "@/features/guide/use-guide";

/**
 * The list's place while the scope in view holds no Task at all (counts.tasks; live, finished or shelved): a welcome,
 * one line on how this differs from a chat, and a picture of how work goes (WorkPicture), in one column a little above
 * the middle of the list's place (by the screen's height alone, so it never moves when the input at the foot grows),
 * clear of that input. Under it, once the getting-started guide is over or closed, the line to the phone and app guide
 * (AppHint). This is the first screen a new person sees; the guide's one balloon then points at the input.
 */
export function Welcome() {
  const { t } = useTranslation("tree");
  const step = useGoingGuide();
  // It rises into place in three parts, each a little after the one above, every time it is put on the screen
  // (motion.css, animate-welcome).
  return <section data-welcome className="flex justify-center px-5 pt-[clamp(24px,calc(40dvh-190px),160px)] pb-6 narrow:pt-[clamp(20px,calc(100dvh-700px),96px)]">
    <div className="w-[min(100%,44rem)] text-ink">
      <h2 className="m-0 animate-welcome text-center text-balance text-display font-semibold [word-break:auto-phrase]">{t("welcome.title")}</h2>
      <p className="mx-auto mt-3 mb-0 max-w-md animate-welcome text-center text-balance text-md text-muted [word-break:auto-phrase] [animation-delay:calc(var(--motion-fast)/2)] motion-reduce:[animation-delay:0s]">{t("welcome.lead")}</p>
      <div className="animate-welcome [animation-delay:var(--motion-fast)] motion-reduce:[animation-delay:0s]">
        <WorkPicture />
        {/* The phone and app guide waits until the getting-started guide is over or closed. */}
        {!step && <div className="mx-auto mt-6 max-w-md"><AppHint /></div>}
      </div>
    </div>
  </section>;
}

/**
 * How work goes, in three small line drawings joined by arrows, each with a few words under it: a request is sent from
 * the input; the coordinator makes it Tasks and puts an AI on each; they are listed, and the person's turn comes under
 * Awaiting review. Side by side on a computer, one under another on a phone (the drawing left of its words). The
 * drawings carry no meaning the words do not, so they are hidden from a screen reader; the words are read in order.
 * Drawn in the screen's colours, their stroke at the icon set's 1.5px.
 */
function WorkPicture() {
  const { t } = useTranslation("tree");
  const parts: { name: string; picture: ReactNode; words: string }[] = [
    { name: "send", picture: <SendPicture />, words: t("welcome.picture.send") },
    { name: "split", picture: <SplitPicture />, words: t("welcome.picture.split") },
    { name: "listed", picture: <ListedPicture />, words: t("welcome.picture.listed", { section: t("home.turn") }) },
  ];
  return <ol data-welcome-picture className="m-0 mt-9 flex list-none items-start justify-center gap-2 p-0 narrow:mt-6 narrow:flex-col narrow:items-stretch narrow:gap-1">
    {parts.map((part, at) => <li key={part.name} data-welcome-picture-part={part.name} className="contents">
      {at > 0 && <Icon name="arrowRight" aria-hidden="true" className="mt-6 size-4 flex-none text-soft narrow:mt-0 narrow:ml-[3.25rem] narrow:rotate-90" />}
      <div className="flex max-w-56 flex-1 flex-col items-center gap-2 text-center narrow:max-w-none narrow:flex-row narrow:gap-4 narrow:text-left">
        {part.picture}
        <span className="text-sm text-balance text-ink [word-break:auto-phrase] narrow:text-pretty">{part.words}</span>
      </div>
    </li>)}
  </ol>;
}

const PICTURE = "h-16 w-[7.5rem] flex-none";
function Drawing({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 120 64" aria-hidden="true" fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={PICTURE}>
    {children}
  </svg>;
}

/** The input: a rounded box with a label at its left end and a line of words. */
function SendPicture() {
  return <Drawing>
    <rect x="6" y="21" width="108" height="22" rx="11" className="fill-lit stroke-muted" />
    <rect x="13" y="27" width="28" height="10" rx="3" className="fill-ink/12 stroke-none" />
    <path d="M48 32h36" className="stroke-soft" />
  </Drawing>;
}

/** The coordinator: one circle, its lines going out to three boxes. */
function SplitPicture() {
  return <Drawing>
    <circle cx="24" cy="32" r="11" className="fill-lit stroke-ink" />
    <path d="M36 28 78 12M36 32h42M36 36l42 16" className="stroke-soft" />
    <g className="fill-lit stroke-muted">
      <rect x="80" y="5" width="34" height="14" rx="3" />
      <rect x="80" y="25" width="34" height="14" rx="3" />
      <rect x="80" y="45" width="34" height="14" rx="3" />
    </g>
  </Drawing>;
}

/** The list: three rows, the middle one in the colour of the person's turn. */
function ListedPicture() {
  return <Drawing>
    <path d="M22 14h88M22 50h88" className="stroke-soft" />
    <circle cx="13" cy="14" r="2.5" className="fill-soft stroke-none" />
    <circle cx="13" cy="50" r="2.5" className="fill-soft stroke-none" />
    <rect x="6" y="24" width="108" height="16" rx="3" className="fill-turn/15 stroke-turn" />
    <circle cx="16" cy="32" r="3" className="fill-turn stroke-none" />
    <path d="M26 32h60" className="stroke-turn" />
  </Drawing>;
}
