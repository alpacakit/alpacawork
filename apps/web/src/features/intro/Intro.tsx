import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogCloseButton, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useDeviceValue } from "@/lib/device-storage";
import { useCoarsePointer, useInstalledApp } from "@/lib/input-capabilities";
import { useListPlace, useWorkspaceInfo } from "@/data/queries";
import { openSettings, useDialogStore } from "@/state/dialog-store";
import { useConversation } from "@/features/coordinator/coordinator";
import { pointsFor, slidesFor, startsIntro, type IntroSlide } from "./intro-definition";
import { closeIntro, introSeen, openIntro, useIntro } from "./intro-state";

/**
 * Each slide's picture, by its file's name: `<language>-<shot>.png`, taken from the real screen in that language
 * (scripts/first-run-preview/intro-shots.ts). A language with no pictures of its own shows the English ones.
 */
const shots = import.meta.glob<string>("./shots/*.png", { eager: true, query: "?url", import: "default" });
const shotOf = (language: string, shot: string) => shots[`./shots/${language}-${shot}.png`] ?? shots[`./shots/en-${shot}.png`];

/**
 * The introduction, mounted once with the page: it opens by itself on a new person's first look (startsIntro), once
 * the page has no dialog open, and is drawn while it is open (opened by itself, or from the welcome or the settings).
 */
export function Intro() {
  const seen = useDeviceValue(introSeen);
  const welcome = useListPlace() === "welcome";
  const tasks = useWorkspaceInfo((info) => info.counts.tasks.root ?? 0);
  // What the person has said to the coordinator; not known until its conversation is read.
  const said = useConversation((state) => state.conversation ? state.conversation.turns.length : null);
  const free = useDialogStore((state) => state.dialog === null);
  const starts = startsIntro(seen, welcome, tasks, said) && free;
  useEffect(() => { if (starts) openIntro(); }, [starts]);
  return useIntro((state) => state.open) ? <IntroDialog /> : null;
}

/**
 * The introduction to how the work goes: the slides of intro-definition.ts, one at a time, each a picture of the real
 * screen with its numbered points under it. It can be left at any slide (Skip, ×, Esc, a press outside), which is
 * remembered on this browser so it never opens by itself again; the welcome and the settings open it again.
 * One size whatever the slide holds (a large dialog), so its buttons stay where they are from slide to slide.
 */
export function IntroDialog() {
  const { t, i18n } = useTranslation("tree");
  const slides = slidesFor(useCoarsePointer());
  const [index, setIndex] = useState(0);
  const at = Math.min(index, slides.length - 1), slide = slides[at]!, last = at === slides.length - 1;
  const move = (by: number) => setIndex(Math.max(0, Math.min(slides.length - 1, at + by)));
  // A slide is read from its picture down: turned to, it starts at its top wherever the one before was scrolled to.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [at]);
  return <Dialog open onOpenChange={(open) => { if (!open) closeIntro(); }}>
    <DialogContent size="large" data-intro data-intro-slide={slide.id} aria-describedby={undefined}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === "ArrowRight") move(1); else if (event.key === "ArrowLeft") move(-1);
      }}>
      <header className="flex flex-none items-center justify-between gap-2 px-6 pt-4 pb-3 narrow:px-4.5">
        <p className="m-0 text-sm text-muted">{t("intro.label")}<span className="ml-2 tabular-nums">{at + 1} / {slides.length}</span></p>
        <DialogCloseButton />
      </header>
      <DialogBody ref={body} aria-live="polite">
        {/* The picture's place is one height whatever the picture's shape, so the words under it never move, and it
            leaves the words their room on a short screen; on a phone's width the picture's own height is its place.
            Every slide's picture is in the page from the start, so the next one is there when it is turned to. */}
        <div className="flex h-[min(29rem,calc(100dvh-30.5rem))] min-h-40 items-center justify-center narrow:h-auto narrow:min-h-0">
          {slides.map((each) => <img key={each.id} src={shotOf(i18n.language, each.shot)} alt="" data-intro-shot={each.shot}
            className={cn("max-h-full max-w-full rounded-lg border border-line", each !== slide && "hidden")} />)}
        </div>
        <Words slide={slide} />
        {/* The settings open at the tab in the introduction's place (over them already, they only move to the tab). */}
        {slide.settings && <Button variant="outline" data-intro-settings className="mt-4"
          onClick={() => { const { tab } = slide.settings!; closeIntro(); openSettings(tab); }}>{slide.settings.label(t)}</Button>}
      </DialogBody>
      <footer className="flex flex-none items-center gap-2 border-t border-line px-6 py-3 narrow:px-4.5">
        {/* At the end, where it is opened again: the welcome's own way back goes with the welcome, at the first Task. */}
        {last ? <p className="m-0 min-w-0 flex-1 text-sm text-pretty text-muted [word-break:auto-phrase]">{t("intro.againHint", { settings: t("panels:settings.title"), personal: t("panels:settings.tabs.personal") })}</p>
          : <Button variant="quiet" data-intro-skip onClick={closeIntro}>{t("intro.skip")}</Button>}
        <div className="ml-auto flex flex-none items-center gap-2">
          {at > 0 && <Button variant="outline" data-intro-back onClick={() => move(-1)}>{t("intro.back")}</Button>}
          {last ? <Button data-intro-done onClick={closeIntro}>{t("intro.done")}</Button>
            : <Button data-intro-next onClick={() => move(1)}>{t("intro.next")}</Button>}
        </div>
      </footer>
    </DialogContent>
  </Dialog>;
}

/** A slide's words under its picture: the title, then what the picture shows, numbered as the picture numbers it. */
function Words({ slide }: { slide: IntroSlide }) {
  const { t } = useTranslation("tree");
  const points = pointsFor(slide, useInstalledApp());
  return <div className="mt-5 [word-break:auto-phrase]">
    <DialogTitle className="text-display font-semibold text-balance">{slide.title(t)}</DialogTitle>
    {slide.lead && <p className="mt-2 mb-0 text-base text-pretty text-muted">{slide.lead(t)}</p>}
    <ol className="m-0 mt-4 flex list-none flex-col gap-2.5 p-0">
      {points.map((point, n) => <li key={point.id} className="flex gap-3">
        <span aria-hidden="true" className="flex h-[1lh] flex-none items-center">
          <span className="flex size-5.5 items-center justify-center rounded-full bg-turn text-sm font-semibold text-bg tabular-nums">{n + 1}</span>
        </span>
        <p className="m-0 min-w-0 text-base text-pretty"><b className="font-semibold">{point.name(t)}</b><span className="text-muted">{" — "}{point.say(t)}</span></p>
      </li>)}
    </ol>
    {slide.note && <p className="mt-4 mb-0 text-base text-pretty text-muted">{slide.note(t)}</p>}
  </div>;
}
