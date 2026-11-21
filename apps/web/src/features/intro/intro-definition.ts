import type { TFunction } from "i18next";

/**
 * The introduction a new person is shown before their first request, in one place: its slides in order, each with its
 * picture, its words and the numbered points under the picture.
 *
 * To change it, edit SLIDES and the words in tree.json (`intro.*`, every language), then take the pictures again
 * (`node scripts/try-first-run.ts --intro-shots`, which reads this file):
 * - `id`: the slide's name;
 * - `shot`: its picture's name. The picture is `shots/<language>-<shot>.png (the server serves no other kind of picture)`, taken from the real screen in the state
 *   the capture script puts it in for that name (scripts/first-run-preview/intro-shots.ts, SCENES). One picture
 *   belongs to one slide: its numbers are that slide's points;
 * - `title` and, around the points, `lead` and `note`: its words, by their keys, written out so the extractor reads them;
 * - `points`: what the picture shows, numbered in this order. `part` is the part of the screen a point is about, by the
 *   data attribute the screen gives it: the capture script rings that part in the picture (everything the selector
 *   finds, as one) and writes the point's number on it. A point without a part is said under the picture only;
 *   `unless: "installed"` leaves a point out of the installed app's window (only a point without a part, since the
 *   picture's numbers are fixed);
 * - `settings`: a button under the words that opens the settings at that tab;
 * - `pointer`: "fine" for a slide shown only where there is a mouse (what it leads to is not on a touch screen).
 * Nothing else names a slide: the dialog and the capture script read them from here.
 */
export type IntroPoint = { id: string; part?: string; unless?: "installed"; name: (t: TFunction) => string; say: (t: TFunction) => string };
export type IntroSlide = {
  id: string;
  shot: string;
  title: (t: TFunction) => string;
  lead?: (t: TFunction) => string;
  points: readonly IntroPoint[];
  note?: (t: TFunction) => string;
  settings?: { tab: "apps"; label: (t: TFunction) => string };
  pointer?: "fine";
};

/** The box at the foot where requests are written: folded to one line, or open. */
const INPUT = "[data-coordinator-capsule], [data-composer-frame]";
/** A section of the list (In progress, Awaiting review, …): its heading's words and its rows' names. */
const section = (name: string) => `[data-section="${name}"] h2, [data-section="${name}"] + ol [data-row-label]`;
/** The rows of a section alone. */
const rows = (name: string) => `[data-section="${name}"] + ol [data-row-label]`;

export const SLIDES: readonly IntroSlide[] = [
  // How the work goes, on the list: the three steps, each on the part of the screen where it happens.
  { id: "flow", shot: "flow", title: t => t("tree:intro.flow.title"), lead: t => t("tree:intro.flow.lead"),
    points: [
      { id: "send", part: INPUT, name: t => t("tree:intro.flow.send.name"), say: t => t("tree:intro.flow.send.say") },
      { id: "work", part: section("doing"), name: t => t("tree:intro.flow.work.name"), say: t => t("tree:intro.flow.work.say", { section: t("tree:home.running") }) },
      { id: "turn", part: section("review"), name: t => t("tree:intro.flow.turn.name"), say: t => t("tree:intro.flow.turn.say", { section: t("tree:home.turn") }) },
    ] },
  // The parts of the screen, with a Task open in the detail.
  { id: "parts", shot: "parts", title: t => t("tree:intro.parts.title"),
    points: [
      { id: "list", part: "[data-section], [data-section] + ol", name: t => t("tree:intro.parts.list.name"), say: t => t("tree:intro.parts.list.say", { running: t("tree:home.running"), turn: t("tree:home.turn") }) },
      { id: "detail", part: "aside[data-reader-mode]", name: t => t("tree:intro.parts.detail.name"), say: t => t("tree:intro.parts.detail.say") },
      { id: "input", part: INPUT, name: t => t("tree:intro.parts.input.name"), say: t => t("tree:intro.parts.input.say") },
      { id: "conversation", part: "[data-coordinator-pill]", name: t => t("tree:intro.parts.conversation.name"), say: t => t("tree:intro.parts.conversation.say", { open: t("ui:coordinatorCard.expand") }) },
    ] },
  // The person's turn: a question open in the detail, a choice picked and waiting in the input.
  { id: "turn", shot: "turn", title: t => t("tree:intro.turn.title"),
    points: [
      { id: "open", part: rows("review"), name: t => t("tree:intro.turn.open.name", { section: t("tree:home.turn") }), say: t => t("tree:intro.turn.open.say") },
      { id: "choose", part: "[data-waiting-report-actions] [data-question]", name: t => t("tree:intro.turn.choose.name"), say: t => t("tree:intro.turn.choose.say") },
      { id: "answer", part: "[data-ask-send]:not(.sr-only)", name: t => t("tree:intro.turn.answer.name"), say: t => t("tree:intro.turn.answer.say") },
    ],
    note: t => t("tree:intro.turn.note", { finish: t("ui:coordinatorCard.done") }) },
  // The same screen as an app on the computer and from a phone; the way to both is the settings' Apps tab.
  { id: "apps", shot: "phone", pointer: "fine", title: t => t("tree:intro.apps.title"),
    points: [
      { id: "desktop", unless: "installed", name: t => t("tree:intro.apps.desktop.name"), say: t => t("tree:intro.apps.desktop.say") },
      { id: "phone", name: t => t("tree:intro.apps.phone.name"), say: t => t("tree:intro.apps.phone.say") },
    ],
    note: t => t("tree:intro.apps.note", { settings: t("panels:settings.title"), apps: t("panels:settings.tabs.apps") }),
    settings: { tab: "apps", label: t => t("tree:intro.apps.open") } },
];

/** The slides for this device: all of them, less those for a mouse where there is none. */
export const slidesFor = (coarsePointer: boolean): readonly IntroSlide[] => SLIDES.filter(slide => !(slide.pointer === "fine" && coarsePointer));

/** A slide's points here: all of them, less those left out of the installed app's window. */
export const pointsFor = (slide: IntroSlide, installed: boolean): readonly IntroPoint[] =>
  slide.points.filter(point => !(point.unless === "installed" && installed));

/**
 * Whether the introduction opens by itself: on a browser that has never closed it, with the welcome on the screen, no
 * Task in the whole workspace and nothing said to the coordinator yet (a new person's first look; not someone with work
 * elsewhere opening an empty project, nor someone who has only talked with the coordinator so far). `said` is how many
 * messages the coordinator's conversation holds, null while that is not known: it waits until it is.
 */
export const startsIntro = (seen: boolean, welcome: boolean, tasks: number, said: number | null) =>
  !seen && welcome && tasks === 0 && said === 0;
