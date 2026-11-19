import { useQuery } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button, HEAD_MARK } from "@/components/ui/button";
import { CopyButton, CopyMark, useCopy } from "@/components/ui/copy-button";
import { DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Icon, type IconName } from "@/components/ui/icon";
import { ReadFailure } from "@/components/ui/loadable";
import { Message } from "@/components/ui/message";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { filesOfRead, useAttachmentBytes, useWorkspaceInfo } from "@/data/queries";
import { ApiError } from "@/data/client";
import { FILE_READ_BYTES, resources } from "@/data/resources";
import { showable } from "@/domain/task-files";
import { viewerAddress, viewerCopy, viewerTarget, type ViewerTarget } from "@/domain/viewer-target";
import { textClip } from "@/lib/clipboard";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { listenSheetPress, pullsFrom } from "@/lib/sheet-press";
import { leaveSheet, sheetHand, sheetMotion } from "@/lib/sheet-motion";
import { arise, duration } from "@/lib/motion";
import { usePanelGoing } from "../panel-going";
import { deviceValue, jsonCodec, useDeviceValue, type DeviceValue } from "@/lib/device-storage";
import { cn } from "@/lib/utils";
import { closeView } from "@/state/history-step";
import { NARROW_QUERY, useNarrow, useViewStore } from "@/state/view-store";
import { diffDocument, useDiffNaming, type DiffNaming } from "../diff/DiffPages";
import { CommitList, CommitsToggle, DiffTitle } from "../diff/commits";
import { drawnBytes, drawnFromText, fileDocument, fileReading, NotText, type DrawnFile } from "./FilePages";
import { originalUrl, savedFileLink, taskCodeUrl, taskFileLink, taskFileUrl } from "@/data/task-file-url";
import { FileLinkAnchor } from "../FileLinkAnchor";
import { groupFiles } from "../diff/diff-files";
import { readsSideBySide, viewerLayout } from "./viewer-layout";
import { chooseLook, useLookChoice } from "./viewer-look";

/**
 * What the viewer shows of what it read, a diff and a file alike: its pages (a diff's files; a file is one), read open
 * or closed in place; how many lines it changes or holds, by which it is laid out (viewerLayout); and, for a diff, its
 * counts as the title. The only things a diff adds are in its pages' names and bodies (DiffPages.tsx) and its counts.
 */
export type ViewerPage = {
  key: string;
  /** Its path, by which the list puts it in a folder and narrows. */
  path: string;
  /** What stands after its name in its heading, faint and cut at its start: its folder, or where it was renamed from. */
  place: string;
  /** Its name, with what a diff says of it; on one line (`line`: a heading, the list) or folded (the viewer's title). */
  name: (line: boolean) => ReactNode;
  body: (look: Look) => ReactNode;
};
/**
 * How a page is read: side by side (else one above the other), the same for every page of a diff, its code and its
 * documents alike (readsSideBySide); a document by its lines as written (else by its words).
 */
export type Look = { split: boolean; source: boolean };
export type ViewerDocument =
  /**
   * `looks`: which looks change anything in it (none for a file), so only those are offered: `split` where a file both
   * removes and adds lines, `code` where such a file is code (read side by side from a wider frame), `source` where one
   * is a document.
   */
  | { kind: "pages"; pages: ViewerPage[]; counts: ReactNode | null; lines: number; looks: { split: boolean; code: boolean; source: boolean } }
  /** A text the viewer cannot cut into pages (a diff too large, or no patch): shown whole. */
  | { kind: "whole"; content: ReactNode };

/** Opens a file in the viewer over the reader: a Task's file (relative path) or one of its code locations (absolute). */
export const openView = (owner: string, path: string) => useViewStore.getState().setView(viewerAddress(owner, path));

/**
 * Where a computer reads it: in the list's place beside the docked reader (`page`), which stays where it was read, or
 * over the reader's reports under its head while the reader takes the whole screen (`reader`: Workbench decides).
 */
export type ViewerPlace = "page" | "reader";

/**
 * The file the URL names (`view`). On a phone it is read over the page, the whole screen; on a computer where `place`
 * says. It is a surface the URL holds, as a picture is: opening it is a step of its own, so Back closes it; its × and
 * Escape close it (closeView). What it reads is read when it opens (and once a reload opens it again): a Task's saved
 * diff or file, or a file of the Task's code locations now.
 */
export function UrlViewer({ renderProse, onFollow, place }: { renderProse: (text: string) => ReactNode; onFollow: (id: string) => void; place: ViewerPlace }) {
  const address = useViewStore(state => state.view);
  const narrow = useNarrow();
  const target = address ? viewerTarget(address) : null;
  if (!target) return null;
  const reading = { renderProse, onFollow };
  // A computer's stays one surface while one file follows another in it (the Files tab's rows beside it): only what it reads changes.
  return narrow ? <ViewerDialog key={address} target={target} reading={reading} />
    : <ViewerPanel address={address!} target={target} place={place} reading={reading} />;
}

/** What the viewer draws what it read with: a diff's prose, and where a task reference in a drawn file goes. */
type Reading = { renderProse: (text: string) => ReactNode; onFollow: (id: string) => void };

/** What the viewer read, as it is laid out: its document once read, why it cannot be, a report diff's versions. */
function useViewerRead(target: ViewerTarget, { renderProse, onFollow }: Reading) {
  // Where it is read from is the only difference before the pages: a Task's file, or a file of its code locations.
  const fromTask = useTaskFile(target, target.where === "task"), fromCode = useCodeFile(target, target.where === "code");
  const { text, failure, range, file, letters, original } = target.where === "task" ? fromTask : fromCode;
  const doc = useMemo(() => target.reads === "diff" ? typeof text === "string" ? diffDocument(text, target.path, renderProse) : null
    : text !== undefined ? fileDocument(target.path, text, file && { ...file, onFollow }) : null, [text, target, renderProse, file, onFollow]);
  // What the head offers of the file itself, the same rule wherever it is read from: a file's letters to copy (a diff
  // has its own copies: its command and its pages' paths), and its original to save.
  const takes: Takes = { text: target.reads === "file" ? letters : null,
    save: original ? { href: originalUrl(original), name: fileName(target.path) } : null };
  return { doc, failure, range, takes };
}

/**
 * What a reader takes of the file itself, from the viewer's head: its letters as read (`text`, to copy: a document's
 * or a table's own, however it is drawn), and the file saved as stored under its own name (`save`: its address with
 * `download=1`). Each is null where the file gives none: no text read (too large, not text, missing), nothing to save
 * (missing, unreadable).
 */
export type Takes = { text: string | null; save: { href: string; name: string } | null };
const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * What a target reads: its text once read (null: a Task's page or table, drawn before its text is read), or why it
 * cannot be; for a Task's report diff, what names it (diffNaming); for a Task's file, the Task and the file, by which
 * it is drawn (fileDocument).
 */
type Read = { text: string | null | undefined; failure: ReactNode | null; range: DiffNaming | null; file?: Omit<DrawnFile, "onFollow">;
  /** Its letters as read, however it is drawn (null: none read); and its address where it is there to save (null: it is not). */
  letters: string | null; original: string | null };

function useTaskFile(target: ViewerTarget, enabled: boolean): Read {
  const { t } = useTranslation("reader");
  const root = useWorkspaceInfo(info => info.root);
  const maxBytes = useAttachmentBytes();
  const view = useQuery({ ...resources.taskView(root, target.owner), enabled });
  const task = view.data?.task, files = view.data && filesOfRead(view.data);
  const file = files?.find(each => each.name === target.path);
  const readable = enabled && !!file && file.readable !== false && showable(file, maxBytes) && file.size <= FILE_READ_BYTES;
  const range = useDiffNaming(target.owner, target.reads === "diff" ? file : undefined);
  const fromText = target.reads === "diff" || drawnFromText(fileReading(target.path));
  // A diff is read as its text; a file as it is, its bytes said to be no text where they are not (fileText): its one
  // read of bytes, a table's too. Its words are asked for as it opens, up to what its drawing reads (drawnBytes): past
  // that (a table too large to draw) this asks for none, so none are copied, until its lines are read (a computer's
  // source look: LaterLines), which is this same read.
  const revision = file?.revision ?? "";
  const diff = useQuery({ ...resources.diffText(root, target.owner, target.path, revision), enabled: readable && target.reads === "diff" });
  const whole = useQuery({ ...resources.fileText(root, target.owner, target.path, revision),
    enabled: readable && target.reads === "file" && !!file && file.size <= drawnBytes(fileReading(target.path)) });
  const text = target.reads === "diff" ? diff : whole;
  const drawn = useMemo(() => task && files && file ? { task: { id: task.id, title: task.title, files }, file } : undefined, [task, files, file]);
  // Why it cannot be shown, in the body's place: no such file, one that cannot be read, one too large to show or not
  // text (these two with the file itself to open).
  const original = file && <FileLinkAnchor link={taskFileLink(target.owner, file, maxBytes)} />;
  // Missing by the list read, whatever a later read of it did; with none read, by its failure.
  const failure = (view.data ? !file : view.isError) ? <Message tone="caution" icon="file" title={t("viewer.missing")} />
    : file?.readable === false ? <ReadFailure what={t("ruleTab.readFailed")} note={t("ruleTab.readFailedHelp")} />
    : file && !readable ? <Message tone="caution" icon="file" title={t("viewer.tooLarge")} description={original} />
    : fromText && text.data === null && file ? <NotText link={savedFileLink(taskFileUrl(target.owner, file.name, file.revision))} />
    : fromText && text.isError ? <ReadFailure what={t("viewer.cannotOpen")} error={text.error} retry={() => void text.refetch()} /> : null;
  // Its original is there to save wherever it is there to read, opened here or not (too large, not text).
  return { text: failure ? undefined : readable && !fromText ? null : text.data ?? undefined, failure, range, file: drawn,
    letters: typeof whole.data === "string" ? whole.data : null,
    original: file && file.readable !== false ? taskFileUrl(target.owner, file.name, file.revision) : null };
}

function useCodeFile(target: ViewerTarget, enabled: boolean): Read {
  const { t } = useTranslation("reader");
  const root = useWorkspaceInfo(info => info.root);
  const text = useQuery({ ...resources.codeFile(root, target.owner, target.path), enabled });
  // Why it cannot be opened, in a few words (its path to copy is in the head above).
  const why = text.error instanceof ApiError ? CODE_REFUSAL[text.error.reason?.kind ?? ""] : undefined;
  const failure = text.isError ? <div data-viewer-refused="">
    {why ? <Message tone="caution" icon="file" title={why(t)} /> : <ReadFailure what={t("viewer.cannotOpen")} error={text.error} retry={() => void text.refetch()} />}
  </div> : null;
  // Saved where it is read (the server refuses the same files either way).
  return { text: text.data, failure, range: null, letters: text.data ?? null,
    original: text.data !== undefined ? taskCodeUrl(target.owner, target.path) : null };
}

/**
 * A phone's viewer: the whole screen over the page. A finger takes it down as it takes a phone's sheet down
 * (useSlideAway), and closed by any way, it goes down as a sheet goes.
 */
function ViewerDialog({ target, reading }: { target: ViewerTarget; reading: Reading }) {
  useEscapeLayer(true, ESCAPE_LAYER.image, () => closeView());
  const { doc, failure, range, takes } = useViewerRead(target, reading);
  const inside = useSlideAway();
  return <DialogPrimitive.Root open onOpenChange={next => { if (!next) closeView(); }}>
    <DialogContent aria-describedby={undefined} data-viewer={target.reads} data-diff-viewer={target.reads === "diff" ? "" : undefined}
      // It covers the whole screen at once: rising over a dimmed page would show the page's words through it for a moment.
        // Held by a finger, it has a sheet's top edge and shadow (SHEET_SURFACE), so it parts from what it uncovers; the
        // edge's room is kept unseen at rest, so what it shows does not move as it is taken. What it uncovers is not
        // dimmed (a sheet dims nothing): over a phone it hides the dialog's dimming, which only showed as it was taken.
        className="flex animate-none! flex-col overflow-hidden narrow:h-dvh narrow:max-h-none narrow:w-screen narrow:max-w-none narrow:rounded-none narrow:border-x-0 narrow:border-b-0 narrow:border-t-hairline narrow:border-t-transparent narrow:data-sheet-held:border-t-lit-line narrow:data-sheet-held:shadow-float narrow:[[data-slot=dialog-overlay]:has(+&)]:bg-transparent">
      <div ref={inside} className="contents" />
      <ViewerBody doc={doc} failure={failure} range={range} takes={takes} target={target} desktop={null} address={null} />
    </DialogContent>
  </DialogPrimitive.Root>;
}

/**
 * A phone's viewer is a sheet that is whole or gone: a finger going down from its head, or from the top of what it shows
 * (pullsFrom), carries it down as a phone's sheet is carried (sheet-press, sheetHand), and let go where a sheet would go
 * whole it comes back up, else it closes and goes down at the finger's speed (leaveSheet), as a sheet does. Closed by
 * ×, Esc or Back it goes down too; replaced by another file, or by a computer's viewer as the screen widens, it does
 * not. Returns the ref of a box inside the viewer's surface (the dialog's content, which keeps its own ref).
 */
function useSlideAway() {
  const [inside, setInside] = useState<HTMLElement | null>(null);
  const sent = useRef<number | undefined>(undefined);
  const surface = inside?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? null;
  useLayoutEffect(() => {
    if (!surface) return;
    const motion = sheetMotion(surface, { most: () => innerHeight, bottom: () => innerHeight, stand: () => innerHeight });
    // Back at rest it takes the screen's height again as it changes (h-dvh), not the height it was let go at.
    const whole = () => { surface.style.height = ""; };
    const hand = sheetHand(motion, { pull: true, stand: () => innerHeight, rests: () => null, rested: whole,
      land: (landing, speed) => { if (landing.to === "away") { sent.current = speed; closeView(); } else motion.settle(innerHeight, whole, () => innerHeight, speed); } });
    const stop = listenSheetPress(surface, (event, target) => pullsFrom(event, target, surface) ? { press: hand, capture: surface } : null);
    return () => {
      // It goes down from where it is drawn now (a finger's hand still holding it there), before it is put back.
      if (!useViewStore.getState().view && matchMedia(NARROW_QUERY).matches) leaveSheet(surface, sent.current);
      stop(); motion.stop(); whole();
    };
  }, [surface]);
  return setInside;
}

/**
 * A computer's viewer. Beside the docked reader (`page`) it stands right of it, in the room the reader leaves as it
 * moves to the screen's left (Reader), a surface of the page as the reader is: the same edges, corners, top and shadow,
 * the reader's gap between them (the list and its bar go out of sight once the reader is over them: Workbench). It
 * rises into that room as the reader leaves it, and sinks as it closes, the reader moving back (styles.css, Panel).
 * In either place it runs to the screen's foot, as the list does. Beside the reader it stands at the window's right edge,
 * which the coordinator stays left of (frame.ts besidePanel); over the reader, what stands over that foot (the
 * coordinator's input, the task's actions) only adds room at the end of what scrolls (data-viewer-scroll), so its last
 * line comes clear of them.
 * As it opens, the keys go to what it reads (Pages), so j, k and the arrows work at once; closed, they go back to what
 * opened it (a report's "Open the diff") when that is still there.
 */
function ViewerPanel({ address, target, place, reading }: { address: string; target: ViewerTarget; place: ViewerPlace; reading: Reading }) {
  const { t } = useTranslation("reader");
  // A surface of the page, not over it: a menu opened over it closes first on Escape.
  useEscapeLayer(true, ESCAPE_LAYER.dialog, () => closeView());
  const { doc, failure, range, takes } = useViewerRead(target, reading);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    // Beside the reader, it rises into the room the reader leaves, the reader leading (styles.css, Panel).
    if (place === "page") arise(panel.current, { step: "slow", delay: duration("fast") / 2 });
    // Closed, the keys go back to what opened it, unless they were already taken elsewhere (⌘K's search).
    const box = panel.current;
    return () => {
      const at = document.activeElement;
      if (opener?.isConnected && (!at || at === document.body || box?.contains(at))) opener.focus({ preventScroll: true });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- as it opens
  }, []);
  // Closed (its ×, Escape, Back alike), beside the reader it sinks the way it rose.
  usePanelGoing(panel, place === "page" ? (now, before) => !!before.view && !now.view : null, "sink", [place]);
  const section = <section ref={panel} tabIndex={-1} aria-label={t("viewer.label")} data-viewer={target.reads} data-viewer-place={place}
    data-diff-viewer={target.reads === "diff" ? "" : undefined}
    className={cn("flex flex-col overflow-hidden bg-lit outline-none", place === "page"
      ? "fixed inset-y-window right-window left-[calc(var(--window-fit)+var(--spacing-window)*2)] z-(--layer-view) rounded-pane border-hairline border-lit-line shadow-float"
      : "absolute inset-0 z-3")}>
    <ViewerBody key={address} doc={doc} failure={failure} range={range} takes={takes} target={target} desktop={place} address={address} />
  </section>;
  // Out of the reader's box, under the page's own frame, where the reader's width is known (--window-fit).
  return place === "page" ? createPortal(section, document.querySelector("[data-page]") ?? document.body) : section;
}

function ViewerBody({ doc, failure, range, takes, target, desktop, address }: { doc: ViewerDocument | null; failure: ReactNode | null; range: Read["range"];
  takes: Takes; target: ViewerTarget; desktop: ViewerPlace | null; address: string | null }) {
  if (doc?.kind === "pages") return <Pages doc={doc} range={range} takes={takes} desktop={desktop} address={address} copy={viewerCopy(target)} />;
  // A diff being read is named by its counts once read: until then its head keeps its height with no title, rather
  // than its file's name for a moment (a diff file's name says nothing to its reader).
  const reading = target.reads === "diff" && !doc && !failure;
  return <div data-viewer-pages="" className="flex h-full min-h-0 flex-col">
    <ViewerHead desktop={desktop} takes={takes} title={reading ? <span aria-hidden="true" className="invisible">0</span> : <FileTitle path={target.path} />}
      // A computer's head keeps the row its diff's reading and looks will stand on, so its rule does not move as they come.
      nav={reading && desktop ? <span aria-hidden="true" className="h-6" /> : undefined}
      below={<HeadLine path={reading ? null : target.path} copy={viewerCopy(target)} range={range} desktop={!!desktop} />} />
    <div data-viewer-scroll="" className="min-h-0 flex-1 overflow-auto p-4 narrow:p-3">{doc?.content ?? failure ?? <RegionSkeleton shape="text" />}</div>
  </div>;
}

/** Why the server would not give a code file, as a reader is told it (code-files.ts on the server names the reason). */
const CODE_REFUSAL: Record<string, (t: TFunction<"reader">) => string> = {
  code_file_outside: t => t("viewer.outside"), code_file_in_git_folder: t => t("viewer.inGitFolder"), code_file_binary: t => t("viewer.binary"),
  code_file_missing: t => t("viewer.missing"), code_file_shared: t => t("viewer.shared"), file_exceeds_mib: t => t("viewer.tooLarge"),
};

/** An entry of a computer's head's third row: the reader's tab entries' face (24px, a mark and words, muted). */
const HEAD_ENTRY = "flex h-6 min-h-0 flex-none items-center gap-1 rounded-sm px-2 text-sm whitespace-nowrap tabular-nums text-muted";

/**
 * The viewer's head: stays at the top while what is under it scrolls. On a phone its first line is what is read (a diff's
 * counts, a file's name), what acts on all of it, and the viewer's ×; its second, smaller and fainter, what it is read
 * from (its path's copy). Its words start where the headings' and the lines' do (px-4, a phone's px-3).
 *
 * On a computer it is the reader's head beside it, row for row and press for press, so the two read as one pair: on the
 * head's row, what it is read from (`below`: its versions or its path, with their copy) and its × last, the reader's
 * round × whose circle ends where the title does; then what is read at the reader's title size; then, on the row of the
 * reader's tabs and as tall, how far the reading has come (`nav`) and how it is read (`actions`), so the two heads' rules
 * are one line.
 */
function ViewerHead({ title, actions, below, nav, takes, desktop, named, under }: { title: ReactNode; actions?: ReactNode; below: ReactNode; nav?: ReactNode;
  takes: Takes; desktop: ViewerPlace | null; named?: boolean; under?: ReactNode }) {
  const { t } = useTranslation();
  const { t: tr } = useTranslation("reader");
  const Title = desktop ? "h2" : DialogTitle;
  const taken = (takes.text !== null || takes.save) && <HeadTakes takes={takes} words={!!desktop} />;
  if (desktop) {
    const tools = (nav || actions || taken) && <div data-viewer-tools="" className="-ms-2 flex min-h-9 items-center gap-1 py-1.5">
      {nav}<span className="flex min-w-0 flex-1 items-center justify-end gap-2">{taken}{actions}</span></div>;
    const close = tr("viewer.close");
    // A diff named by its commits leads with that name beside its ×, then how much it changes (`below`), then its tools.
    if (named) return <div data-viewer-head="" className="sticky top-0 z-1 flex-none border-b border-rule bg-lit px-4 pt-head-room pb-1">
      <div className="flex min-h-head min-w-0 items-start gap-1">
        <Title className="m-0 min-w-0 flex-1 pt-1 text-ink">{title}</Title>
        <Button variant="ghost" size="icon" data-viewer-close="" aria-label={close} title={close} className={HEAD_MARK}
          onClick={() => closeView()}><Icon name="close" /></Button>
      </div>
      <div data-viewer-source="" className="flex min-h-7 min-w-0 items-center gap-1 text-xs text-muted">{below}</div>
      {tools}
      {under}
    </div>;
    return <div data-viewer-head="" className="sticky top-0 z-1 flex-none border-b border-rule bg-lit px-4 pt-head-room pb-1">
      <div className="flex min-h-head min-w-0 items-center gap-1 text-xs text-muted">
        <div data-viewer-source="" className="flex min-w-0 flex-1 items-center gap-1">{below}</div>
        <Button variant="ghost" size="icon" data-viewer-close="" aria-label={close} title={close} className={HEAD_MARK}
          onClick={() => closeView()}><Icon name="close" /></Button>
      </div>
      <Title className="m-0 mt-[7px] mb-1 flex min-w-0 items-baseline gap-x-2 text-xl text-ink [overflow-wrap:anywhere]">{title}</Title>
      {tools}
      {under}
    </div>;
  }
  return <div data-viewer-head="" className="sticky top-0 z-1 flex flex-col border-b border-rule bg-raised px-4 py-1 narrow:px-3">
    <div className="flex items-center gap-1">
      <Title className="m-0 flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 py-1 text-md font-semibold">{title}</Title>
      {taken}{actions}
      <Button variant="ghost" size="bar" data-viewer-close="" aria-label={t("dialog.close")} title={t("dialog.close")} className="-me-2 active:bg-press"
        onClick={() => closeView()}><Icon name="close" /></Button>
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 pb-1">{below}</div>
    {under}
  </div>;
}

/**
 * Two ways to read the same thing as two marks side by side in one hairline frame, the one read now filled and inked (a
 * fill lighter than the head in the dark as in the light), as code screens show side by side and one over the other.
 * Each mark's name is its press's name and its hint.
 */
function IconChoice({ label, options, chosen, onChoose, name }: { label: string; name: string; chosen: number;
  options: readonly { icon: IconName; words: string }[]; onChoose: (at: number) => void }) {
  // On a phone it is 32px tall and each mark 40px wide, its press 40px tall, under a finger.
  return <div role="group" aria-label={label} data-viewer-choice={name} className="flex h-6 shrink-0 items-center gap-px rounded-sm border-hairline border-lit-line p-px narrow:h-8">
    {options.map(({ icon, words }, at) => <button key={at} type="button" aria-pressed={chosen === at} aria-label={words} title={`${label}: ${words}`}
      onClick={() => onChoose(at)}
      // Its press reaches 4px past the frame above and below (28px tall), its face staying the frame's.
      className="relative flex h-full w-7 cursor-pointer items-center justify-center rounded-[3px] text-muted after:absolute after:inset-x-0 after:-inset-y-1 after:content-[''] hover:text-ink aria-pressed:bg-hover aria-pressed:text-ink narrow:w-10">
      <Icon name={icon} className="size-4" /></button>)}
  </div>;
}

/** A file's name as a title: its name, folded where it is longer than the line. */
function FileTitle({ path }: { path: string }) {
  return <span className="min-w-0 [overflow-wrap:anywhere]">{path.slice(path.lastIndexOf("/") + 1)}</span>;
}

/**
 * What a head's title is read from, small and faint: the file's path (cut at its start, its name kept) with its copy.
 * A report diff's versions are not shown (its SHAs say nothing to a person): a computer copies the git command that
 * shows it by the commits it compared, by a mark at the row's end, to read the same diff in a terminal; a phone has no
 * terminal to paste it in. `path` is null where the title names no one file; `copy`, what its copy gives where that is
 * not the path shown (viewerCopy: a Task's file by its Task).
 */
function HeadLine({ path, copy, range, desktop }: { path: string | null; copy: string | null; range: Read["range"]; desktop: boolean }) {
  return <>
    {/* Its copy right after it, so it reads as the path's (as a Task's ID and its copy do): a long path is cut at its start, the copy kept. */}
    {path !== null && <span className="flex min-w-0 items-center gap-1">
      <span data-viewer-path="" dir="rtl" className="min-w-0 truncate text-left font-mono text-xs text-muted"><bdi>{path}</bdi></span>
      <PathCopy path={copy ?? path} className={desktop ? HEAD_MARK : undefined} />
    </span>}
    {range && desktop && <><span className="flex-1" /><CommandCopy command={range.command} /></>}
  </>;
}

/** The git command that shows a report diff again by the commits it compared, to copy (a computer's). */
function CommandCopy({ command }: { command: string }) {
  const { t } = useTranslation("reader");
  return <CopyButton clip={() => textClip(command)} label={t("viewer.copyCommand")} className={HEAD_MARK} />;
}

/** A computer's head entry pressed in place: HEAD_ENTRY's face, shaded under a pointer, its press 4px past it above and below. */
const HEAD_PRESS = cn(HEAD_ENTRY, "relative cursor-pointer no-underline hover:bg-hover hover:text-ink active:bg-press after:absolute after:inset-x-0 after:-inset-y-1 after:content-['']");
/** A phone's head mark: 44px under a finger, as its × is. */
const PHONE_MARK = "text-muted no-underline hover:text-ink active:bg-press";

/**
 * The file itself, from the head (Takes): its text copied as read, and its original saved. A computer's say their
 * words on the row of how it is read; a phone's are marks beside the ×, named by their label.
 */
function HeadTakes({ takes: { text, save }, words }: { takes: Takes; words: boolean }) {
  const { t } = useTranslation("reader");
  const { t: tu } = useTranslation("ui");
  const [copied, copy] = useCopy(() => textClip(text ?? ""));
  // Named for what it gives, the words it shows among them (a phone shows none).
  const copyName = copied ? tu("copied") : t("viewer.copyText"), saveName = t("viewer.downloadFile");
  return <>
    {text !== null && (words
      ? <button type="button" data-viewer-copy-text="" data-copy={copied ? "done" : ""} aria-label={copyName} title={copyName} onClick={copy} className={HEAD_PRESS}>
        <CopyMark copied={copied} />{t("viewer.copy")}</button>
      : <Button variant="ghost" size="bar" data-viewer-copy-text="" data-copy={copied ? "done" : ""} aria-label={copyName} title={copyName}
        onClick={copy} className={PHONE_MARK}><CopyMark copied={copied} /></Button>)}
    {save && (words
      ? <a href={save.href} download={save.name} data-viewer-download="" aria-label={saveName} title={saveName} className={HEAD_PRESS}>
        <Icon name="download" className="size-3.5" />{t("viewer.download")}</a>
      : <Button asChild variant="ghost" size="bar" className={PHONE_MARK}>
        <a href={save.href} download={save.name} data-viewer-download="" aria-label={saveName} title={saveName}><Icon name="download" className="size-3.5" /></a></Button>)}
  </>;
}

/**
 * What the viewer read, as its pages in folder order (groupFiles). Several are each under a heading that stays at the
 * top while it is read and opens or closes it in place: the closed headings are the list of its pages, so a page read
 * now is left for another by pressing its heading, which closes it where it stands among them. One is its title's,
 * open, with no heading. How they start is their size's (viewerLayout), whatever opened the viewer. An open page's
 * heading copies its path, to name the file to whoever is told about it.
 *
 * On a computer (`desktop`) a diff's looks are chosen in the head (Look: side by side as chosen, else by the frame's
 * width: readsSideBySide), and each heading holds a mark that its page was read (Viewed: it closes and the next not yet read
 * opens), how far the reading has come said in the head. Pressing a heading or its mark never scrolls what is read:
 * the heading pressed stays where it stands, and what it opens or closes does so under it (keepHeading).
 */
function Pages({ doc, range, takes, desktop, address, copy }: { doc: Extract<ViewerDocument, { kind: "pages" }>; range: Read["range"]; takes: Takes;
  desktop: ViewerPlace | null; address: string | null; copy: string | null }) {
  const { t } = useTranslation("reader");
  const { pages } = doc;
  const layout = viewerLayout(pages.length, doc.lines);
  const ordered = useMemo(() => groupFiles(pages).flatMap(group => group.files), [pages]);
  const [viewed, setViewed] = useViewed(address);
  const [commitsOpen, setCommitsOpen] = useState(false);
  // On a computer it starts where the reading was left: the pages marked read closed, the first not yet read open (and
  // brought to the top below), even where the others start on their closed headings, for what is read first is a
  // change, not a list of names. A phone's screen is a list of names first (its headings are its list).
  const firstUnread = desktop ? ordered.find(page => !viewed.has(page.key)) : undefined;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(layout.open ? pages.filter(page => !desktop || !viewed.has(page.key)).map(page => page.key)
    : firstUnread ? [firstUnread.key] : []));
  const body = useRef<HTMLDivElement>(null);
  // How it is read on a computer: as chosen, else side by side once the frame is wide enough (readsSideBySide).
  const choice = useLookChoice();
  const width = useWidth(body, !!desktop);
  const look: Look = { split: !!desktop && doc.looks.split && readsSideBySide(choice.split, width, doc.looks.code), source: doc.looks.source && choice.source };
  // Start its colour worker as the pages open; text is readable while its colours arrive.
  useEffect(() => { void import("../diff/diff-runtime").then(runtime => runtime.startPainting()); }, []);
  // Opened on a computer, the keys go to what is read: the arrows and space scroll it.
  useEffect(() => { if (desktop) body.current?.focus({ preventScroll: true }); }, [desktop]);
  /**
   * Where it starts on a computer: the first page not yet read at the top, once it is drawn. Pages laid out only as
   * they come near (content-visibility) take their height once drawn, so it is aligned again a few frames after, until a
   * heading is pressed (`settled`): from then the place is the reader's.
   */
  const settled = useRef(() => {});
  useLayoutEffect(() => {
    const frame = body.current;
    if (!frame || !firstUnread || firstUnread === ordered[0]) return;
    const align = () => {
      const card = frame.querySelector<HTMLElement>(`[data-page-key="${CSS.escape(firstUnread.key)}"]`);
      if (card) frame.scrollTop += card.getBoundingClientRect().top - frame.getBoundingClientRect().top;
    };
    align();
    const view = frame.ownerDocument.defaultView!;
    let frames = 0, handle = view.requestAnimationFrame(function again() { align(); if (++frames < 3) handle = view.requestAnimationFrame(again); });
    const late = view.setTimeout(align, 250);
    settled.current = () => { view.cancelAnimationFrame(handle); view.clearTimeout(late); };
    return settled.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- where it starts, once
  }, []);
  /**
   * The one way a press on a heading (or its Viewed mark) moves what is read: it does not. The heading pressed stays
   * where it is drawn, whatever opens or closes under it, and nothing else is scrolled to. A page closed from its heading
   * stuck at the top keeps that heading there, so the reading goes on where it was, not at a place above it left
   * unseen. `focus`: the heading the keys go to next (the Viewed mark they were on went with the page it closed).
   */
  const [kept, keepHeading] = useState<{ key: string; top: number; focus?: string } | null>(null);
  useLayoutEffect(() => {
    const frame = body.current;
    if (!kept || !frame) return;
    const head = frame.querySelector<HTMLElement>(`[data-page-key="${CSS.escape(kept.key)}"] [data-page-head]`);
    if (head) frame.scrollTop += head.getBoundingClientRect().top - frame.getBoundingClientRect().top - kept.top;
    if (kept.focus) frame.querySelector<HTMLElement>(`[data-page-key="${CSS.escape(kept.focus)}"] [data-page-toggle]`)?.focus({ preventScroll: true });
  }, [kept]);
  const keep = (page: ViewerPage, card: HTMLElement, focus?: string) => {
    settled.current();
    const head = card.querySelector<HTMLElement>("[data-page-head]"), frame = body.current;
    if (head && frame) keepHeading({ key: page.key, top: head.getBoundingClientRect().top - frame.getBoundingClientRect().top, focus });
  };
  const toggle = (page: ViewerPage, card: HTMLElement) => {
    const closing = open.has(page.key);
    keep(page, card);
    setOpen(now => { const next = new Set(now); if (closing) next.delete(page.key); else next.add(page.key); return next; });
  };
  // Read: it closes, as a page done with, and the next one not yet read opens where it stands, so reading goes on there
  // (a computer's way through a long diff); the last one read closes. Unmarked, it stays open.
  const markViewed = (page: ViewerPage, card: HTMLElement, read: boolean) => {
    setViewed(page.key, read);
    const next = read && desktop ? ordered.slice(ordered.findIndex(each => each.key === page.key) + 1).find(each => !viewed.has(each.key)) : undefined;
    if (next) {
      keep(page, card, next.key);
      setOpen(now => { const after = new Set(now); after.delete(page.key); after.add(next.key); return after; });
    } else if (read === open.has(page.key)) toggle(page, card);
  };
  const only = layout.heads ? null : pages[0]!;
  // How it is read, on a computer: each choice in sight as two marks, the one read now pressed, kept once chosen.
  // A document is read drawn or by its lines on a phone too, the choice at the end of the head's second line; side by
  // side is a computer's only, a phone's frame being too narrow for two columns.
  const source = doc.looks.source && <IconChoice name="source" label={t("viewer.sourceGroup")}
    options={[{ icon: "preview", words: t("viewer.rendered") }, { icon: "code", words: t("viewer.source") }]}
    chosen={look.source ? 1 : 0} onChoose={at => chooseLook({ source: at === 1 })} />;
  const looks = desktop && <>
    {doc.looks.split && <IconChoice name="split" label={t("viewer.splitGroup")}
      options={[{ icon: "columns", words: t("viewer.split") }, { icon: "rows", words: t("viewer.unified") }]}
      chosen={look.split ? 0 : 1} onChoose={at => chooseLook({ split: at === 0 })} />}
    {source}
  </>;
  const phoneLooks = !desktop && source && <span className="ms-auto">{source}</span>;
  const list = <div ref={body} tabIndex={desktop ? -1 : undefined} data-viewer-body="" data-viewer-scroll="" className="min-h-0 flex-1 overflow-auto outline-none">
    {only ? <section data-page={only.path} data-page-key={only.key} className="py-3">{only.body(look)}</section>
      : <div>{ordered.map(page => {
        const shown = open.has(page.key);
        const read = viewed.has(page.key);
        return <section key={page.key} data-page={page.path} data-page-key={page.key} data-page-viewed={read || undefined} className="border-b border-rule">
          {/* Its heading, one line, stays at the top while it is read; pressed, it opens or closes the page. Its rule
              under it parts it from its open body; closed, the page's own rule is the one line between headings.
              A pointer over any of it shades the whole heading, and its press shades the whole heading too (as the report's
              diff summary's rows do): it is one row, its press opening or closing the page. */}
          <div data-page-head="" className={cn("sticky top-0 z-1 flex items-center gap-1 bg-raised pe-2 hover:bg-hover has-[[data-page-toggle]:active]:bg-press narrow:pe-1", shown && "border-b border-rule")}>
            <button type="button" data-page-toggle="" aria-expanded={shown} onClick={event => toggle(page, event.currentTarget.closest("section")!)}
              className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-2 ps-4 pe-2 text-left text-sm narrow:ps-3", read && "text-muted")}>
              <Icon name={shown ? "down" : "right"} className="size-4 shrink-0 text-muted" />
              {page.name(true)}
              {/* After the name, faint: cut at its start, then left out, where the line has no room for it. */}
              <span dir="rtl" className="min-w-0 flex-1 basis-0 truncate text-left text-xs text-muted"><bdi>{page.place}</bdi></span>
            </button>
            {/* Open, its path's copy and, on a computer, its Viewed mark last: a page is marked read as it is read, so
                a closed one holds no mark to press, only a quiet tick in the same place once it was read. No frames,
                so a long list of headings reads as names, not as rows of buttons. */}
            {shown && <PathCopy path={page.path} />}
            {desktop && shown && <label data-page-viewed-mark="" className="flex min-h-7 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-xs text-muted hover:text-ink has-checked:text-done">
              {/* The app's own box, not the browser's: a hairline square, filled in Done's green with a tick once read. */}
              <span className="relative grid size-4 place-items-center">
                <input type="checkbox" checked={read} className="peer size-4 cursor-pointer appearance-none rounded-[4px] border border-muted/60 bg-lit hover:border-ink checked:border-done checked:bg-done focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink"
                  onChange={event => markViewed(page, event.currentTarget.closest("section")!, event.currentTarget.checked)} />
                <Icon name="check" className="pointer-events-none absolute size-3 text-lit opacity-0 peer-checked:opacity-100" />
              </span>
              {t("viewer.viewed")}</label>}
            {desktop && !shown && read && <Icon name="check" data-page-read="" aria-label={t("viewer.viewed")} className="me-1.5 size-4 shrink-0 text-done" />}
          </div>
          {/* An open page off the screen is laid out only when it comes near (content-visibility): a large diff open whole stays light. */}
          {/* Code starts at once under its heading, its first band against the heading's rule; words keep their room. */}
          {shown && <div data-page-body="" className="pt-3 pb-4 [contain-intrinsic-size:auto_480px] [content-visibility:auto] has-[>[data-line-rows]:first-child]:pt-0">{page.body(look)}</div>}
        </section>;
      })}</div>}
  </div>;
  const viewedCount = desktop && layout.heads && <span data-viewer-viewed-count="" className={cn(HEAD_ENTRY, viewed.size === pages.length && "text-done")}>
    {/* The tick says the checking is done, so it comes, green, only with the last file. */}
    {viewed.size === pages.length && <Icon name="check" className="size-3.5" />}{t("viewer.viewedCount", { read: viewed.size, total: pages.length })}</span>;
  // A diff named by its commits leads with their title; under it how much it changes (or its one file) and its commits,
  // folded until pressed. Its versions are only copied.
  if (range?.title) return <div data-viewer-pages="" className="relative flex h-full min-h-0 flex-col">
    <ViewerHead desktop={desktop} takes={takes} named
      title={<DiffTitle title={range.title} className={cn("line-clamp-2", desktop ? "text-lg font-semibold" : "text-base")} />}
      nav={viewedCount} actions={looks}
      below={<>
        <span className={cn("flex min-w-0 flex-1 flex-wrap items-center gap-x-2", !desktop && "text-sm text-muted")}>
          {only ? <>{only.name(false)}<PathCopy path={only.path} className={desktop ? HEAD_MARK : "-me-2"} /></> : doc.counts}
          <CommitsToggle commits={range.commits} open={commitsOpen} onToggle={() => setCommitsOpen(open => !open)} className={desktop ? undefined : "-ms-1.5"} /></span>
        {desktop && <CommandCopy command={range.command} />}{phoneLooks}</>}
      under={commitsOpen && range.commits && <CommitList commits={range.commits} />} />
    {list}
  </div>;
  return <div data-viewer-pages="" className="relative flex h-full min-h-0 flex-col">
    <ViewerHead desktop={desktop} takes={takes} title={only ? only.name(false) : doc.counts}
      // A computer: how far the reading has come, on the row of the reader's tabs beside it, as quiet as their words.
      nav={viewedCount}
      actions={looks}
      below={<><HeadLine path={only ? only.path : null} copy={copy} range={range} desktop={!!desktop} />{phoneLooks}</>} />
    {list}
  </div>;
}

/** A page's path to copy, as the one quiet mark a heading holds: 44px under a finger. */
function PathCopy({ path, className }: { path: string; className?: string }) {
  const { t } = useTranslation("reader");
  return <CopyButton clip={() => textClip(path)} label={t("files.copyPath")} className={cn("shrink-0 narrow:size-11", className)} />;
}

/** The whole width of a frame, its scrollbar's too, kept as it changes (`on`: a computer's, which chooses a look by it). */
function useWidth(frame: React.RefObject<HTMLElement | null>, on: boolean) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!on || !element) return;
    setWidth(element.offsetWidth);
    const observer = new ResizeObserver(() => setWidth(element.offsetWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame, on]);
  return width;
}

/** The pages marked read in one document, kept on the device: one stored value per document address. */
const viewedValues = new Map<string, DeviceValue<readonly string[]>>();
const pageList = jsonCodec<readonly string[]>(kept => Array.isArray(kept) && kept.every(page => typeof page === "string") ? kept as string[] : null);
const viewedOf = (address: string) => {
  let value = viewedValues.get(address);
  if (!value) viewedValues.set(address, value = deviceValue(`alpacawork.viewed.${address}`, pageList, []));
  return value;
};
/** No document: nothing marked, nothing kept. */
const NO_PAGES: readonly string[] = [];
const NONE: DeviceValue<readonly string[]> = { get: () => NO_PAGES, set: () => "memory", remove: () => "memory", subscribe: () => () => {} };
/** How many pages of a document (`address`) are marked read on this device, kept current as they are marked (a report's card). */
export function useViewedCount(address: string): number {
  return useDeviceValue(viewedOf(address)).length;
}

/** The pages marked read in this document (`address`), kept on the device so a reader coming back finds them so. */
function useViewed(address: string | null): [ReadonlySet<string>, (key: string, read: boolean) => void] {
  const value = address ? viewedOf(address) : NONE;
  const pages = useDeviceValue(value);
  const viewed = useMemo(() => new Set(pages), [pages]);
  const mark = (page: string, read: boolean) => {
    if (!address) return;
    const next = new Set(value.get());
    if (read) next.add(page); else next.delete(page);
    value.set([...next]);
  };
  return [viewed, mark];
}
