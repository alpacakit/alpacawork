import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { Sentences } from "@/components/ui/sentences";
import { useGoingGuide, useGuideScreen } from "@/features/guide/use-guide";

/**
 * The list's place while the scope in view holds no Task at all (counts.tasks; live, finished or shelved): a welcome,
 * one line on what this place is for, and a picture of how work goes (WorkPicture), in one column a little above
 * the middle of the list's place (by the screen's height alone, so it never moves when the input at the foot grows),
 * clear of that input; on a phone it starts near the top, so the picture ends above the input. This is the first screen
 * a new person sees; on a computer the guide's one balloon then points at the input, and elsewhere, where the computer's
 * guide is not shown (useGuideScreen), one line under the picture says where it is.
 */
export function Welcome() {
  const { t } = useTranslation("tree");
  const going = !!useGoingGuide("computer"), shown = useGuideScreen() === "computer";
  const elsewhere = going && !shown;
  // It rises into place in three parts, each a little after the one above, every time it is put on the screen
  // (motion.css, animate-welcome).
  return <section data-welcome className="flex justify-center px-5 pt-[clamp(24px,calc(40dvh-190px),160px)] pb-6 narrow:pt-[clamp(8px,calc(100dvh-836px),96px)]">
    <div className="w-[min(100%,52rem)] text-ink">
      <h2 className="m-0 animate-welcome text-center text-balance text-display font-semibold [word-break:auto-phrase]">{t("welcome.title")}</h2>
      <p className="mx-auto mt-3 mb-0 max-w-md animate-welcome text-center text-balance text-md text-muted [word-break:auto-phrase] [animation-delay:calc(var(--motion-fast)/2)] motion-reduce:[animation-delay:0s]">{t("welcome.lead")}</p>
      <div className="animate-welcome [animation-delay:var(--motion-fast)] motion-reduce:[animation-delay:0s]">
        <WorkPicture />
      </div>
      {elsewhere && <p data-guide-elsewhere className="mx-auto mt-6 mb-0 max-w-md text-center text-balance text-sm text-muted [word-break:auto-phrase]">{t("welcome.guideOnComputer")}</p>}
    </div>
  </section>;
}

/**
 * How work goes, in four small line drawings joined by arrows, each with a few words under it: a request is sent from
 * the input; the coordinator makes it Tasks; the AI on each (its owner) takes it and splits it into child Tasks when it
 * needs to; they are listed, and the person's turn comes under Awaiting review. Side by side on a computer, one under
 * another on a phone (the drawing left of its words). The drawings carry no meaning the words do not, so they are
 * hidden from a screen reader; the words are read in order. Drawn in the screen's colours, their stroke at the icon
 * set's 1.5px.
 */
function WorkPicture() {
  const { t } = useTranslation("tree");
  const parts: { name: string; picture: ReactNode; words: string }[] = [
    { name: "send", picture: <SendPicture />, words: t("welcome.picture.send") },
    { name: "split", picture: <SplitPicture />, words: t("welcome.picture.split") },
    { name: "own", picture: <OwnPicture />, words: t("welcome.picture.own") },
    { name: "listed", picture: <ListedPicture />, words: t("welcome.picture.listed", { section: t("home.turn") }) },
  ];
  return <ol data-welcome-picture className="m-0 mt-9 flex list-none items-start justify-center gap-2 p-0 narrow:mt-4 narrow:flex-col narrow:items-stretch narrow:gap-1">
    {parts.map((part, at) => <li key={part.name} data-welcome-picture-part={part.name} className="contents">
      {at > 0 && <Icon name="arrowRight" aria-hidden="true" className="mt-6 size-4 flex-none text-soft narrow:mt-0 narrow:ml-[3.25rem] narrow:rotate-90" />}
      <div className="flex max-w-56 flex-1 flex-col items-center gap-2 text-center narrow:max-w-none narrow:flex-row narrow:gap-4 narrow:text-left">
        {part.picture}
        <span className="text-sm text-ink"><Sentences words={part.words} /></span>
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

/** The owner: one Task with its AI, its lines going out to two child Tasks, each with an AI of its own. */
function OwnPicture() {
  return <Drawing>
    <path d="M50 32 72 17M50 32l22 15" className="stroke-soft" />
    <g className="fill-lit stroke-muted">
      <rect x="6" y="21" width="44" height="22" rx="3" />
      <rect x="72" y="6" width="42" height="22" rx="3" />
      <rect x="72" y="36" width="42" height="22" rx="3" />
    </g>
    <g className="fill-lit stroke-ink">
      <circle cx="17" cy="32" r="4" />
      <circle cx="83" cy="17" r="4" />
      <circle cx="83" cy="47" r="4" />
    </g>
    <path d="M26 32h16M92 17h14M92 47h14" className="stroke-soft" />
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
