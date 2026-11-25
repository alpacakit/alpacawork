import type { ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The screen's own icon set, drawn on a 24px grid with
 * a 1.5 stroke. The screen uses these instead of lucide so every glyph is
 * drawn in the same style. Size and stroke come from `className` where a place draws
 * them differently (a state label, a fold toggle, ...).
 */
const paths = {
  /* The display language, marked so that it is found in a language one cannot read. */
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  microphone: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6" /></>,
  todo: <circle cx="12" cy="12" r="8" />,
  doing: (
    <>
      <circle cx="12" cy="13" r="7" />
      <path d="M12 10v4l2 1M9 2h6M12 2v4" />
    </>
  ),
  waiting: <path d="M5 4h14v13h-5l-3 3v-3H5zM8 8h8M8 11h5" />,
  held: <path d="M6 3.5h12v17l-6-4-6 4z" />,
  /* Your turn's two shapes: a review checks what was made, a question asks you something. */
  review: <path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9.25 14l2 2 3.75-4.25" />,
  question: <path d="M5 4h14v13h-5l-3 3v-3H5zM10 8.6a2 2 0 1 1 2.6 1.9c-.4.15-.6.45-.6.85v.45M12 14.1v.15" />,
  done: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  stopped: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M10 9v6M14 9v6" />
    </>
  ),
  /* Sends an answer: a paper plane, as a chat's send. */
  plane: <path d="M20.5 3.5 3.5 10.5l7 3 3 7zM20.5 3.5l-10 10" />,
  chat: <path d="M5.5 5h13a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H11l-4.5 3.5v-3.5h-1a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />,
  /* The same bubble with something not yet read: its corner opens round a point in the not-yet-read colour, so the
     point belongs to the glyph, keeps its stroke's weight and box, and the bubble is not redrawn when it is read. */
  chatNew: <><path d="M13 5H5.5a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h1V20l4.5-3.5h7.5a2 2 0 0 0 2-2V12" /><circle cx="19.5" cy="5.5" r="4" className="fill-changed stroke-none" /></>,
  reply: <path d="m9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7" />,
  /* Into the input (the empty list's examples): the return key's arrow. */
  enter: <path d="M19.5 4.5v8.25H6M10.5 8.25 6 12.75l4.5 4.5" />,
  /* What came back for the line above (a member's result under its Request): down from it, then on to the words. */
  answer: <path d="M4.5 4.5v8.25H18M13.5 8.25 18 12.75l-4.5 4.5" />,
  right: <path d="m9 5 7 7-7 7" />,
  left: <path d="m15 5-7 7 7 7" />,
  down: <path d="m5 9 7 7 7-7" />,
  up: <path d="m5 15 7-7 7 7" />,
  /** Load the page again (the gear's mark once a new version runs). */
  reload: <path d="M18.5 12A6.5 6.5 0 1 1 16.6 7.4M18.5 4.5v3.5H15" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  /* An instruction the agent has not read yet: a clock, as a chat marks a message still on its way. */
  unread: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  /* A code's lines folded at the frame's edge: the middle line runs to the edge and comes back under itself. */
  wrap: <path d="M4 6.5h16M4 12h12.25a3.25 3.25 0 0 1 0 6.5H12.5M14.5 16.5l-2 2 2 2M4 18.5h4" />,
  /* The same lines kept whole: the middle line runs on past the edge. */
  unwrap: <path d="M4 6.5h16M4 12h16.5M18 9.5l2.5 2.5-2.5 2.5M4 17.5h9" />,
  expand: <path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" />,
  /* Every part opened: two chevrons pointing apart, as code screens draw "expand all". */
  unfold: <path d="m7 9 5-5 5 5M7 15l5 5 5-5" />,
  /* Every part closed: the same two chevrons pointing together. */
  fold: <path d="m7 4 5 5 5-5M7 20l5-5 5 5" />,
  /* A change read side by side (before, after) or one over the other: a frame parted down or across, as code screens draw them. */
  columns: <path d="M4.5 5h15v14h-15zM12 5v14" />,
  rows: <path d="M4.5 5h15v14h-15zM4.5 12h15" />,
  /* A document read as it shows (an eye) or as written (its source, code's brackets). */
  preview: <><path d="M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12z" /><circle cx="12" cy="12" r="2.75" /></>,
  code: <path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.25 5.5l-2.5 13" />,
  /* Whole screen: one arrow out to the top right, one to the bottom left. */
  maximize: <path d="M14.5 3.5h6v6M20.5 3.5l-7 7M9.5 20.5h-6v-6M3.5 20.5l7-7" />,
  /* Back to a sheet: the same two arrows, pointing in. */
  minimize: <path d="M19.5 10.5h-6v-6M13.5 10.5l7-7M4.5 13.5h6v6M10.5 13.5l-7 7" />,
  human: (
    <>
      <circle cx="12" cy="7" r="3" />
      <path d="M6 21v-4a6 6 0 0 1 12 0v4" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="6" width="14" height="13" rx="3" />
      <path d="M12 3v3M9 11h.01M15 11h.01M9 15h6" />
    </>
  ),
  /* The folded bar's menu. */
  menu: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  /* The image viewer's video row. Play and pause are filled, as `run` is, so whether it plays reads from the shape. */
  play: <path d="M8 5.5v13l10-6.5z" fill="currentColor" />,
  pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" />,
  /* The square before a row's count of running agents. It fills the grid, as a mark of a text's size does. */
  runningRuns: <rect x="2" y="2" width="20" height="20" fill="currentColor" stroke="none" />,
  sound: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />,
  muted: <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5" />,
  /* The way to the top of the list: drawn, not ⌂, whose glyph stands wider or narrower by the font. */
  home: <path d="M4 11.5 12 4.5l8 7M6.5 9.5v10h11v-10" />,
  warn: <path d="M12 4v10M12 19v.5" />,
  /* A message that asks for care before something goes wrong (components/ui/message.tsx caution): a triangle with a mark. */
  caution: <><path d="M10.7 4.8 3.6 17.5a1.5 1.5 0 0 0 1.3 2.2h14.2a1.5 1.5 0 0 0 1.3-2.2L13.3 4.8a1.5 1.5 0 0 0-2.6 0z" /><path d="M12 9.5v4.5M12 16.75v.25" /></>,
  /* A place with nothing in it yet (components/ui/message.tsx empty): an open tray. */
  empty: <><path d="M4 13.5h4.5l1.25 2.5h4.5l1.25-2.5H20" /><path d="M6.6 6.2 4 13.5V18a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 18v-4.5l-2.6-7.3A1.5 1.5 0 0 0 16 5.2H8a1.5 1.5 0 0 0-1.4 1z" /></>,
  /* Out of reach: a cloud struck through, the mark that says what is shown is as of an earlier time. */
  offline: <path d="M7.5 18.5h9.5a3.5 3.5 0 0 0 .9-6.9 5.5 5.5 0 0 0-9.7-2.4M5.9 11.2A3.75 3.75 0 0 0 7.5 18.5M3.5 3.5l17 17" />,
  edit: <path d="M4 20h4l11-11-4-4L4 16zM13 7l4 4" />,
  settings: (
    <>
      <path d="M9.51 5.25L10.15 2.68L13.85 2.68L14.49 5.25L15.01 5.46L17.28 4.10L19.90 6.72L18.54 8.99L18.75 9.51L21.32 10.15L21.32 13.85L18.75 14.49L18.54 15.01L19.90 17.28L17.28 19.90L15.01 18.54L14.49 18.75L13.85 21.32L10.15 21.32L9.51 18.75L8.99 18.54L6.72 19.90L4.10 17.28L5.46 15.01L5.25 14.49L2.68 13.85L2.68 10.15L5.25 9.51L5.46 8.99L4.10 6.72L6.72 4.10L8.99 5.46Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  // A broom: the handle down to its head, and the bristles fanned at its foot.
  clear: <path d="M19.5 3.5 12 11M9.75 9.25l5 5-3.25 6.25H4.5l1-6zM8 20.5l1.25-3.5M11 20.5l.5-1.5" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  moon: <path d="M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z" />,
  /* Task-folder files in the Files tab. */
  file: <path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12.5h6M9 16h4" />,
  /* Kept in place: a padlock, its shackle over the body. */
  lock: <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />,
  archive: <path d="M3.5 5h17v4h-17zM5 9v10.5h14V9M10 13h4" />,
  folder: <path d="M3.5 6h6l2 2.5h9v10h-17z" />,
  /* A column at the left of a frame: the report standing beside what is read (folded or shown). */
  sidebar: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9.5 4.5v15" /></>,
  /* Save a file as it is: an arrow down onto the ground it lands on. */
  download: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="m3.5 16 5-4.5 4 3.5 2.5-2 5 4" />
      <circle cx="15.5" cy="9.5" r="1.25" />
    </>
  ),
  /* Timeline marks: what happened, on the same grid and stroke. */
  error: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.5M12 15.75v.25" />
    </>
  ),
  /* A toast that tells, neither done nor failed (lib/notify.ts info): the error's ring with an i. */
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8v.25" />
    </>
  ),
  /* A check under way (lib/notify.ts pending): a ring three quarters drawn, turned by animate-spin. */
  pending: <path d="M12 4a8 8 0 1 1-8 8" />,
  request: <path d="M7 17 17 7M9 7h8v8" />,
  report: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  /* The reader's History tab: a clock turned back, unlike the plain clock of an instruction not yet read. */
  history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" /><path d="M4 4v4.5h4.5" /><path d="M12 8v4l3 2" /></>,
  /* History's arrows: from the one a record came from to the one it went to (ReportFeed's RowName), and on its rail
     up to someone above them or down to someone under them (history-rows' rowWay). */
  arrowRight: <path d="M5 12h13M13 7l5 5-5 5" />,
  arrowUp: <path d="M12 19V6M7 11l5-5 5 5" />,
  arrowDown: <path d="M12 5v13M7 13l5 5 5-5" />,
  /* Who a History row was between, by kind (ReportFeed's PartyTag): the open Task as its rail with the mark on it, and a
     Task above it, under it or beside it as the one of two that is filled. */
  /*
   * A History row's Tasks are one set of squares, each mark as a whole seen centred on the line its words stand
   * on. The open Task alone is filled (the user's choice): the one being read. Every other Task is a hollow square, and
   * the branch beside it says where it stands from the open one.
   *   thisTask    the filled square
   *   parentTask  a branch going down out of the square, to this one under it; it stands higher than the others'
   *               squares, as its branch below would otherwise weigh it down
   *   childTask   a branch from above into the square, as a tree draws what is under it
   *   otherTask   a branch from the side into the square: another Task, neither above nor under
   * A member is this Task's hand: round as the screen's people are, and a ring, so that on a phone it is never
   * read as the filled square of the Task it works for, nor as the filled dot that says something is unread. Its line
   * is drawn thicker than the set's 1.5, and the ring a little wider than the square, so the hole stays open at 14px.
   */
  thisTask: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />,
  parentTask: <><rect x="4" y="5.5" width="9" height="9" rx="1.5" /><path d="M13 10h6v7" /></>,
  childTask: <><path d="M5 5v7h6" /><rect x="11" y="7.5" width="9" height="9" rx="1.5" /></>,
  otherTask: <><path d="M3 12h8" /><rect x="11" y="7.5" width="9" height="9" rx="1.5" /></>,
  member: <circle cx="12" cy="12" r="5" strokeWidth={2.5} />,
  run: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />,
  /* Auto-swipe: a card going off to the right. The card is one closed shape, so fill="currentColor" draws it on
     (TaskActions); the arrow keeps its line either way. */
  autoSwipe: <><rect x="3.5" y="5.5" width="10" height="13" rx="1.5" /><path d="M16.5 12h5M19 9.5l2.5 2.5-2.5 2.5" fill="none" /></>,
  swap: <path d="M4 8h15l-4-4M20 16H5l4 4" />,
  // Held and moved up or down: a handle between the way up and the way down (a phone sheet's sizing area).
  dragHandle: <path d="M4 9.5h16M4 14.5h16" strokeWidth={2.25} />,
  /* The parent and child tasks: a parent box with its children hanging below it. */
  family: <><rect x="3.5" y="3.5" width="6" height="5" rx="1" /><rect x="14.5" y="10" width="6" height="5" rx="1" /><rect x="14.5" y="16.5" width="6" height="4" rx="1" /><path d="M6.5 8.5v10h8M6.5 12.5h8" /></>,
  /* When a task is expected to report, a flag on its pole, as at a race's end. */
  flag: <><path d="M6.5 20.5v-16" /><path d="M6.5 4.5h12l-3 4.25 3 4.25h-12z" fill="currentColor" /></>,
  record: <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />,
  /* Change state: a state's ring with its point. */
  state: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></>,
  /* The coordinator's own window (picture-in-picture): out of the screen into it, and back. */
  popOut: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <rect x="12" y="11.5" width="6" height="5" rx="0.75" fill="currentColor" stroke="none" />
    </>
  ),
  popIn: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <rect x="12" y="11.5" width="6" height="5" rx="0.75" fill="currentColor" stroke="none" />
      <path d="M11 11 7.5 7.5M7.5 7.5v3.25M7.5 7.5h3.25" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  className,
  ...props
}: { name: IconName } & Omit<SVGProps<SVGSVGElement>, "children">) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      className={cn("size-4 flex-none", className)}
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
