import { countUse } from '@/features/telemetry/count';
import { useReadState } from '@/data/queries';
import { useQueryClient } from '@tanstack/react-query';
import { readerPresentation, subscribeReads } from '@/data/read-model';
import { useServerTasks } from '@/data/queries';
import { coordinatorIntentSchema } from '@alpacawork/contract/coordinator';
import { readerTurn } from '@/features/reader/submission';
import { useSitting } from '@/features/reader/next-question';
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Toaster } from "@/components/ui/toaster";
import { useActionFocus } from './use-action-focus';
import { notify, recordFailure } from "@/lib/notify";
import { useDeviceValue } from "@/lib/device-storage";
import { Button, HEAD_MARK, HEAD_MARK_GAP } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { useCloseOnPhoneBack } from "@/lib/close-on-back";
import { SurfaceDocument, useSurfaceDocument } from "@/lib/surface";
import { cn } from "@/lib/utils";
import { useWorkspaceWritable, useWriteDisabled } from "@/data/queries";
import { CoordinatorInput } from './CoordinatorInput';
import { applyCoordinatorFocus, focusCoordinator, useInputDraft } from './editor/draft';
import { admitOutgoingIdentity, restoreReaderDraft, useOutbox } from './editor/outbox';
import { useReaderSend } from './reader-send';
import { composing, emptied } from './editor/lifecycle';
import { useEveryTaskIndex } from '@/data/queries';
import { useNarrow } from '@/state/view-store';
import { useBar } from '@/state/bar';
import { PhoneSheet } from './PhoneSheet';
import { useCoordinatorSkills } from './editor/skills';
import { readerShows, shownInReader, useViewStore } from "@/state/view-store";
import { useFrameSelector } from "@/data/workspace-store";
import { useConversation } from "./coordinator";
import { useConversationReading } from "./read-boundary";
import { scrollThreadToEnd, useThreadPosition } from './thread-position';
import { MentionMarks } from "./parts";
import { TaskActionSlot, conversationTool, markTool, useRowWords, useTaskActionSlot } from "./task-action-slot";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { ReplyReturn } from './ReplyReturn';
import { ParkedReturn } from './ParkedReturn';
import { ThreadQueue } from "./ThreadQueue";
import { CoordinatorThread } from "./CoordinatorThread";
import { documentPip, openPipWindow } from "./pip-window";
import { LastWordsPill } from "./LastWords";
import { CoordinatorCapsule } from "./CoordinatorCapsule";
import { ShownConversationProvider, useShownConversation } from "./shown";
import { useFoldOnPressAway } from "./fold-on-press-away";
import { COLUMN } from "@/features/reader/reading-column";
import { BETWEEN, ceilingOf, FIRST, keptFrame, type Edge, type Frame } from "./frame";
import { FrameEdge, FrameGrip, FrameHandContext } from "./frame-hand";
import { useFramePlacement } from "./use-frame-placement";
import { goesDownByItself } from "./foot";

/**
 * The AI the conversation's next message goes to, as the server says it (`nextLaunch`: its coordinator AI stack, and the
 * row the conversation is on); null when no row can run. Chosen in the settings, never here.
 */
function useCoordinatorLaunch() {
  const read = useFrameSelector(data => data !== null);
  const conversation = useConversation(state => state.conversation);
  const next = conversation?.nextLaunch ?? null, ready = read && conversation !== null;
  // The same object while it says the same: the input is not drawn again for each update the footer observes.
  return useMemo(() => ({ next, ready }), [next, ready]);
}
const CoordinatorFooter = memo(function CoordinatorFooter() {
  const launch = useCoordinatorLaunch();
  // The input owns its draft. Typing must not commit the card's geometry or its thread.
  const draft = useInputDraft();
  const revision = useReaderSend(state => state.revision);
  const live = useOutbox(state => state.live);
  const conversation = useConversation(state => state.conversation);
  const selectedTask = useViewStore(shownInReader);
  // What the screen shows, on its two layers: the Task the panel shows or awaits, over the project in view (the list's).
  // Nothing is shown before the address is read; then the panel's Task once its read presents it, the project once the
  // index holds it. Until then nothing is observed, so a reload is not taken for the list showing every project, nor a
  // Task still awaited for the project behind it. The draft decides what an opening does (lifecycle.ts).
  const ready = useViewStore(state => state.navigationReady);
  // The reader moving on from a Task it was answered from (next-question's `retired`: to the next waiting Task, or to
  // the card saying every turn there is answered) is the screen leaving that Task. That card stands in the panel in
  // place of the Task it was on, which it no longer shows.
  const retired = useSitting(state => state.retired);
  const answered = useSitting(state => state.emptied?.taskId ?? null);
  const showing = useViewStore(readerShows), panel = showing === answered ? null : showing;
  const project = useViewStore(state => state.project);
  const index = useEveryTaskIndex();
  const client = useQueryClient(), root = JSON.parse(draft.key)[0] as string;
  const serverTasks = useServerTasks();
  const presentation = useSyncExternalStore(changed => subscribeReads(client, changed),
    () => panel ? readerPresentation(client, root, panel).kind : 'absent');
  // The screen leaving a Task, on either layer: the panel closing on it (its ×, Esc, Back, a swipe, the address; a Task
  // still being looked up is no close) or the reader moving on from it, or the project in view changing from it. A move from one Task in the panel to
  // another, or the panel opening over the list, is an opening alone. The draft decides what leaving does
  // (lifecycle.ts). Before the observing below, which then sees the draft leaving left.
  useEffect(() => useViewStore.subscribe((state, before) => {
    const was = readerShows(before);
    if (was && !readerShows(state)) draft.close(was);
    if (before.project && before.project !== state.project) draft.close(before.project);
  }), [draft.key]);
  useEffect(() => { if (retired) draft.close(retired.taskId); }, [retired, draft.key]);
  useEffect(() => {
    // Observe after the editor's mount lifecycle; its initial transaction must precede canonical draft seeding.
    // Browsing only observes a composing draft. Recovery may fill a prepared input; the notice's explicit Open
    // recovers through the same outbox owner even while another draft is being written.
    const task = serverTasks?.find(task => task.id === selectedTask);
    if (!composing(draft.entry.values) && conversation && task && restoreReaderDraft(root, conversation.id, task.id, readerTurn(task)) === true) return;
    // A project the index does not hold yet is not known: the panel's Task is observed alone meanwhile.
    const front = panel ? index.byId.get(panel) : null, behind = project ? index.byId.get(project) : null;
    if (!ready || panel && (!front || presentation === 'refused' || presentation === 'absent') || !panel && project && !behind) return;
    draft.observe({ panel: front ? { id: front.id, title: front.title } : null,
      project: behind ? { id: behind.id, title: behind.title } : project ? undefined : null });
  }, [ready, panel, project, index, serverTasks, presentation, root, draft.key, draft.locked, draft.entry.values.phase, draft.entry.values.seen,
    draft.entry.values.seenProject, emptied(draft.entry.values), revision, live, conversation?.id]);

  return <CoordinatorInput launch={launch} />;
});

/**
 * At the end of the conversation: the messages waiting their turn, the way back to a reply, a parked return, and the
 * task actions (TaskActionSlot). On a computer the actions say their words beside their marks while the foot has room
 * for all of them (else, and on a phone, they are marks alone).
 */
function ThreadEnd({ area, active }: { area: React.RefObject<HTMLDivElement | null>; active: boolean }) {
  const narrow = useNarrow();
  const row = useRef<HTMLDivElement>(null);
  const tools = useRef<HTMLDivElement>(null);
  useRowWords(row, tools, active, narrow);
  // One line in every state, at any width.
  return <div ref={row} data-coordinator-end className="flex items-center gap-2 whitespace-nowrap pt-1 pr-(--foot-inset) pb-(--foot-inset) pl-2 narrow:pt-0 narrow:pb-2 [&:not(:has(button))]:hidden">
    <ThreadQueue area={area} /><ReplyReturn /><ParkedReturn />
    <div ref={tools} className="ml-auto flex min-w-0 items-center justify-end gap-2">
      {active && <TaskActionSlot inThread />}
    </div>
  </div>;
}

/** In its own window, the way back to the screen: where the pane's own controls stand on it (PaneHeadControls), its mark. */
function PopIn({ own }: { own: Window }) {
  const { t } = useTranslation("ui");
  return <HeadControls><HeadButton data-coordinator-pop-in icon="popIn" label={t("coordinatorCard.popIn")} onPress={() => own.close()} /></HeadControls>;
}

/**
 * A conversation surface is its area (its head over its thread) over its foot. The head holds the pane's own controls
 * at its right end; the foot holds the end row's tools at the right, and on a phone the sheet's own (SheetControls) at
 * the left. Lower than both, the thread gives way first and the foot stays whole, with what closes the surface. The
 * foot's round tools stand as far inside the pane as puts each circle on its corner's centre (the pane's rounding less
 * half a conversationTool, --foot-inset; tokens.css --radius-pane) from its side; on a phone they stand 8px over its
 * foot, so the sheet's foot is 44px and the thread keeps the room. What passes under the head or the foot fades
 * (parts.css pane-head-fade, pane-foot-fade). The end row's tools say their words on a computer while they fit
 * (ThreadEnd).
 */
const AREA_UNDER_HEAD = "relative flex min-h-5 flex-1 flex-col [&>[data-card-scroll]]:min-h-0";
const PANE_FOOT = "pane-foot-fade flex flex-none items-end [--foot-inset:calc(var(--radius-pane)-var(--spacing)*4.5)]";
const END_ROW = "min-w-0 flex-1";
/**
 * What scrolls in a conversation surface, and the height of its head (--pane-head): 32px on a phone, only its grip, tall
 * enough for a finger to take it and no taller, so the thread keeps the room; 48px where it holds the pane's controls,
 * as much room under them as over them (HeadControls). A computer's is set on what scrolls, a phone's on the whole
 * sheet (PhoneSheet's grip is as tall); the head and what stands clear of it in the thread (ConversationStart, an answer
 * scrolled to) read it from there. On a phone the area under the head keeps at least the head's height, so the grip
 * never stands over the foot's controls.
 */
const PANE_SCROLL = "flex-1 overflow-y-auto overscroll-contain [&:has([data-coordinator-start])]:[container-type:size]";
const HEAD_WITH_CONTROLS = "[--pane-head:3rem]";
const HEAD_GRIP_ONLY = "[--pane-head:2rem]";

/**
 * The conversation's head line, as low as what it holds so the conversation starts as high as it can. On a phone it
 * is only what holds the sheet by the hand (pulled down past its least it is let go and closes). On a computer and in
 * its own window it holds the pane's own controls (`children`, HeadControls) with as much room under them as over them,
 * so the first line read is not pressed against them. On a computer its ground moves the frame, with the grip shown
 * near its top, by the pane's edge it moves. Its height is the surface's (--pane-head: on what scrolls on a computer,
 * on the whole sheet on a phone, whose grip reads it too), so what is placed under it in the thread reads it from there.
 */
function PanelHead({ grip, children }: { grip?: boolean; children?: React.ReactNode }) {
  return <div data-card-grab data-frame-ground={grip || undefined} data-coordinator-panel-head
    className={cn("pane-head-fade sticky top-0 z-10 h-(--pane-head) flex-none touch-none bg-raised", grip && "cursor-grab [[data-coordinator-held]_&]:cursor-grabbing")}>
    {grip && <FrameGrip className="top-0.5" touch />}
    {children}
  </div>;
}

/**
 * Where the pane's own controls stand: the head's right end, each circle 8px inside the pane's top and side as the
 * input's round action is, so the last one shares its corner's centre (tokens.css --radius-pane). They are the
 * reader's frame buttons' face and room (HEAD_MARK, HEAD_MARK_GAP): a mark alone, no ground until pointed at.
 */
function HeadControls({ children }: { children: React.ReactNode }) {
  return <div data-coordinator-pane-controls className={cn("absolute top-2 right-2 flex items-center", HEAD_MARK_GAP)}>{children}</div>;
}

function HeadButton({ icon, label, title = label, pressed, expanded, onPress, ...data }: { icon: IconName; label: string; title?: string; pressed?: boolean;
  expanded?: boolean; onPress: () => void; [data: `data-${string}`]: unknown }) {
  return <Button variant="ghost" size="icon" {...data} aria-pressed={pressed} aria-expanded={expanded} aria-label={label} title={title} onClick={onPress}
    className={HEAD_MARK}><Icon name={icon} /></Button>;
}

/** What folds the conversation into its input: ∨ where the input is under it, ∧ where it is over it. */
function useFold(sheet?: boolean) {
  const { t } = useTranslation("ui");
  return {
    label: t("coordinatorCard.fold"), title: t("coordinatorCard.foldHint"),
    press: () => {
      countUse('coord.fold');
      // On a phone it lets go of the input as the sheet pulled down does (PhoneSheet handOver), so the keyboard goes
      // down with it: a press there need not take the focus (Safari's does not).
      if (sheet && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      useConversation.getState().setExpanded(false);
    },
  };
}

/**
 * A computer's pane controls, in its head (HeadControls): what moves it into its own window (where the browser has
 * one), then what sizes it as large as the hand could (↗↙) and back to the last size the hand left it smaller (↙↗), as
 * the reader's Expand does (placeMaximized), and last, in the corner where the reader has its ×, what closes it.
 * Maximized is only that size, as if the hand had pulled it so: the grip and the edges stay, and the hand sizes and
 * moves it on from there.
 */
function PaneHeadControls({ edge, popOut, maximize }: { edge: Edge; popOut?: () => void; maximize: { maximized: boolean; toggle: () => void } }) {
  const { t } = useTranslation("ui");
  const fold = useFold();
  const { maximized } = maximize;
  return <HeadControls>
    {popOut && <HeadButton data-coordinator-pop-out icon="popOut" label={t("coordinatorCard.popOut")} title={t("coordinatorCard.popOutHint")} onPress={popOut} />}
    <HeadButton data-coordinator-maximize icon={maximized ? "minimize" : "maximize"} label={t(maximized ? "coordinatorCard.restore" : "coordinatorCard.maximize")}
      pressed={maximized} onPress={() => { if (!maximized) countUse('coord.max'); maximize.toggle(); }} />
    <HeadButton data-coordinator-fold icon={edge === "top" ? "up" : "down"} label={fold.label} title={fold.title} expanded onPress={fold.press} />
  </HeadControls>;
}

/**
 * A phone's sheet controls, at its bottom left under the thumb, as the end row's tools are at its bottom right, and of
 * their size and shape (conversationTool, a mark alone). The corner is a place to hold (data-card-grab, as the whole
 * foot and the head are): the sheet's one hand sizes it up or down from there, and let go flicked up it is tallest,
 * flicked down it closes (PhoneSheet, sheetRelease). Beside it stands what closes it; a phone has no ↗↙, its height
 * is the hand's alone. They stay whole when the pane is low (PANE_FOOT).
 */
function SheetControls() {
  const { t } = useTranslation("ui");
  const fold = useFold(true);
  return <div data-coordinator-pane-controls className="flex flex-none items-center gap-2 pb-2 pl-(--foot-inset)">
    {/* Two marks wide, so a thumb finds it, and of the round tools' own edge and ground beside them; its two lines, the
        place-to-hold sign, a step softer than their marks, as it is no press. Held (the sheet in the hand, from anywhere),
        it takes the pressed step, so the hand sees it has it. The foot stays under the finger, so it sizes the sheet twice
        the finger's way (data-grab-gain). */}
    <span data-coordinator-size-area data-card-grab data-sheet-tip aria-hidden="true" title={t("coordinatorCard.heightHint")}
      className={cn(conversationTool, "w-20 cursor-ns-resize touch-none justify-center px-0 text-soft transition-colors duration-100 [[data-sheet-sizing]_&]:border-press-line [[data-sheet-sizing]_&]:bg-press [[data-sheet-sizing]_&]:text-ink")}><Icon name="dragHandle" className="size-7" /></span>
    <button type="button" data-coordinator-fold aria-label={fold.label} title={fold.title} aria-expanded onClick={fold.press}
      className={cn(conversationTool, markTool)}><Icon name="down" className="size-4" /></button>
  </div>;
}

/* Hallmark · component: coordinator card · genre: modern-minimal · theme: the app's own tokens (the hover card's paper)
 * states: pinned (on the screen, where the hand put it) · own window (picture-in-picture, over every app) · back (its window closed)
 */

/**
 * The conversation with the coordinator. It is drawn once, into three elements of its own (what scrolls, its controls, and the input
 * under it), and the surface it is in holds those: the card pinned on the screen, or, where the browser has them, a
 * picture-in-picture window that stays over other apps. So moving between them keeps what is written, what is being
 * sent and what failed. Its window closed (by its own close or the app's window closing), it is the card again.
 * An event in it reaches the components above this one twice (from its own element, and again from the surface that
 * holds it, as React does for a portal inside another); the surface's own handlers (the phone sheet's grip that sizes
 * it) are reached only by the second.
 */
export function CoordinatorCard() {
  return <ShownConversationProvider><Card /></ShownConversationProvider>;
}
function Card() {
  const { t, i18n } = useTranslation("ui");
  const clock = `${i18n.language}|${new Date().toDateString()}|${new Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  const { conversation, open, expanded, focusRequested } = useConversation(useShallow(state => ({
    conversation: state.conversation, open: state.open, expanded: state.expanded, focusRequested: state.focusRequested,
  })));
  const shownConversation = useShownConversation();
  const turns = shownConversation.turns;
  const last = turns.at(-1);
  // Where the hand put it (frame.ts), and while the hand holds it, where it is being put.
  const kept = useDeviceValue(keptFrame);
  const [held, setHeld] = useState<Frame | null>(null);
  const frame = held ?? kept ?? FIRST;
  const narrow = useNarrow();
  const bar = useBar(state => state.hidden ? 0 : state.height);
  const retryIds = useRef(new Map<string, { conversationId: string; id: string }>());
  const disabled = useWriteDisabled();
  const launch = useCoordinatorLaunch();
  const engaged = useConversation(state => state.engaged);
  const catalog = useCoordinatorSkills(launch.next?.agent ?? '');
  const card = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null), outline = useRef<HTMLDivElement>(null), entrance = useRef<HTMLDivElement>(null);
  const [own, setOwn] = useState<Window | null>(null);
  const opening = useRef(false);
  const handBack = useRef(false), tappedAway = useRef(false);
  const [drawn] = useState(() => {
    const body = document.createElement("div"), foot = document.createElement("div"), end = document.createElement("div");
    end.style.display = "contents";
    foot.style.display = "contents";
    const holder = (host: HTMLElement) => (slot: HTMLElement | null) => { if (slot && host.parentNode !== slot) slot.append(host); };
    return { body, foot, end, holdBody: holder(body), holdFoot: holder(foot), holdEnd: holder(end) };
  });
  // Each area names data-card-scroll in its min-height rule, so stillCopy keeps that mark on the departing body.
  const [area, holdArea] = useState<HTMLDivElement | null>(null);
  const threadArea = useMemo(() => ({ current: area }), [area]);
  useConversationReading(own?.document ?? document, useConversation(state => state.root), conversation?.id ?? null);
  // Ref attachment connects the footer; its layout effect prepares the canonical draft first.
  // This surface is the one focus consumer; it commits that draft before resolving the requested position.
  // A consumed request makes later moves between surfaces leave the user's selection alone.
  useLayoutEffect(applyCoordinatorFocus, [open, expanded, own, frame, drawn, focusRequested]);
  const { shown, footSize, maximized, toggleMaximized, hand } = useFramePlacement({ surfaces: { card, panel, outline, entrance }, frame, setHeld, open, expanded, own, narrow, bar });
  // Put down with the focus in it (sent, Esc), the input hands the focus to its line, so the keys keep their place.
  // The focus may have dropped to the page already (its send button disabled while sending): it was in the input last.
  useEffect(() => {
    const foot = drawn.foot;
    let inside = false;
    const enter = () => { inside = true; };
    // Dropped to nowhere (what held it disabled or taken away) is not moved elsewhere.
    const leave = (event: FocusEvent) => { if (event.relatedTarget) inside = foot.contains(event.relatedTarget as Node); };
    foot.addEventListener("focusin", enter); foot.addEventListener("focusout", leave);
    const stop = useConversation.subscribe((next, before) => {
      const at = foot.ownerDocument.activeElement;
      // Put down by a tap away, the focus is where the hand went (words of the page drop it to nowhere).
      if (before.open && !next.open && inside && !tappedAway.current && (!at || at === foot.ownerDocument.body || foot.contains(at))) handBack.current = true;
    });
    return () => { stop(); foot.removeEventListener("focusin", enter); foot.removeEventListener("focusout", leave); };
  }, [drawn]);
  useEffect(() => {
    if (open || !handBack.current) return;
    handBack.current = false;
    document.querySelector<HTMLElement>("[data-coordinator-write]")?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    const foot = drawn.foot, engage = () => { if (!useConversation.getState().engaged) useConversation.setState({ engaged: true }); };
    foot.addEventListener("focusin", engage); return () => foot.removeEventListener("focusin", engage);
  }, [drawn]);
  // The grip is one, on the far surface: the conversation open, or the input folded. Opened or folded with the focus on
  // the grip (its keys, Esc), the focus goes with it (the one leaving fades out before it is taken away).
  // Whether the focus was last on a grip: one taken away drops it to the page, which says nothing of where it was.
  const onGrip = useRef(false);
  useEffect(() => {
    // A press anywhere (a click on the page moves the focus to it without a focusin) is where the hand is now.
    const seen = (event: Event) => { onGrip.current = event.target instanceof Element && !!event.target.closest("[data-frame-grip]"); };
    document.addEventListener("focusin", seen); document.addEventListener("pointerdown", seen, true);
    return () => { document.removeEventListener("focusin", seen); document.removeEventListener("pointerdown", seen, true); };
  }, []);
  useLayoutEffect(() => {
    const at = document.activeElement;
    if (!onGrip.current || at && at !== document.body && !at.hasAttribute("data-frame-grip")) return;
    const grip = (expanded ? panel.current : card.current)?.querySelector<HTMLElement>(expanded ? "[data-frame-grip]" : ":scope > [data-frame-grip]");
    if (grip && grip !== at) grip.focus({ preventScroll: true });
  }, [expanded, shown]);
  useThreadPosition(drawn.body, area, open && (expanded || own !== null), own ?? narrow, shownConversation.local);
  // Moved, the input keeps the focus, in the window it is now in.
  useEffect(() => { if (open && expanded) drawn.foot.querySelector<HTMLElement>("[data-one-input]")?.focus(); }, [own, drawn]);
  // Closed in the app (its button), its window closes too.
  useEffect(() => { if (!open) own?.close(); }, [open, own]);
  useEffect(() => () => own?.close(), [own]);
  // In its own window Esc does not close it: the key is for what is open over it there.
  // One step down, as Esc and a tap away take it: the conversation folds; folded, the input goes down to its one line
  // (Esc ends a recording with it). Esc waits while what was said is being written out, which would throw it away. A
  // tap away, a look elsewhere rather than a wish to stop, leaves a recording's input up, and one that turned to the
  // coordinator after all (an answer's choice written into it, the conversation opened) leaves it as it is.
  // Nothing puts it down by itself while one speaks: sending waits for the words.
  const stepDown = (by: "key" | "tap", turned = false) => {
    const voice = drawn.foot.querySelector<HTMLElement>("[data-voice-recording]")?.dataset.voiceState;
    if (by === "key" && voice === "finalizing" || by === "tap" && (turned || !goesDownByItself())) return;
    if (expanded) { useConversation.getState().setExpanded(false); return; }
    if (by === "tap" && voice) return;
    tappedAway.current = by === "tap";
    try { useConversation.getState().setOpen(false); } finally { tappedAway.current = false; }
  };
  // Pressed while the conversation is read, the input is as good as up: Esc and a tap away take the press back too.
  const wanted = useConversation(state => state.wanted), up = (open || wanted) && !own;
  useEscapeLayer(up, ESCAPE_LAYER.coordinator, () => { stepDown("key"); return true; });
  // The conversation unfolded is open for a moment only: on a phone Back folds it, as Esc does, along with the page's
  // step. Folded, it is part of the screen's foot, which Back leaves alone.
  useCloseOnPhoneBack(open && expanded && !own, () => useConversation.getState().setExpanded(false));
  // Going from Use to the analysis (by any way: its switch, today's marks, Back, the address) folds the conversation,
  // which would otherwise stand over the charts. Going back to Use leaves it folded; in its own window it stays open.
  useEffect(() => useViewStore.subscribe((state, before) => {
    if (state.analysis && !before.analysis && !own) useConversation.getState().setExpanded(false);
  }), [own]);
  // A tap on what it stands over (the list, a task's report) takes it one step down too, where it goes down by itself.
  useFoldOnPressAway(up, node => [card.current, panel.current, outline.current, entrance.current, drawn.foot, drawn.body, drawn.end]
    .some(surface => surface?.contains(node)), turned => stepDown("tap", turned));
  // The same input and sender survive folding the conversation: a report swipe uses that sender too.
  const footer = createPortal(<SurfaceDocument value={own?.document ?? null}>
    <CoordinatorFooter /></SurfaceDocument>, drawn.foot, "coordinator-footer");
  const folded = !expanded && !own;
  // Folded, its row over the input holds the task actions by the same rule as the open conversation's foot.
  const foldRow = useRef<HTMLDivElement>(null), foldTools = useRef<HTMLSpanElement>(null);
  useRowWords(foldRow, foldTools, folded, narrow);
  const retry = async (turn: typeof turns[number]) => {
    // Pressed again, the same retry goes with the choice it first went with, and with the press's intent or the answered
    // questions the turn carried.
    const intent = turn.intent ? coordinatorIntentSchema.safeParse(turn.intent) : null;
    if (intent && !intent.success) { notify.error(t('forms:reportForm.chooseAgain')); return; }
    const retryKey = JSON.stringify([conversation!.id, turn.id]);
    let again = retryIds.current.get(retryKey);
    if (!again) {
      // A known failed turn is a new user admission. Its later presses keep this ID and original pin,
      // unlike an unanswered outbox request, which only continues its existing admission.
      again = { conversationId: conversation!.id, id: crypto.randomUUID() };
      if (!admitOutgoingIdentity(useConversation.getState().root, again.id)) { notify.error(t('input.storageUnavailable')); return; }
      retryIds.current.set(retryKey, again);
    }
    scrollThreadToEnd(drawn.body);
    try { await useConversation.getState().ask({ conversationId: again.conversationId, id: again.id, retryOf: turn.id, text: turn.ask, ...(turn.tasks ? { tasks: turn.tasks } : {}), attachments: [],
      ...(turn.replyTo ? { replyTo: turn.replyTo.id } : {}), ...(intent?.success ? { intent: intent.data } : {}), ...(turn.answers ? { answers: turn.answers.map(({ task, question }) => ({ task, question })) } : {}) }); }
    // Pressed again, it goes under the same ID (a lost answer is said as unknown, not as this; lib/notify.ts failure).
    catch (error) { notify.failure(error, { about: "coordinator retry", from: "coordinator", text: t("coordinatorCard.sendFailed") }); }
  };
  // Geometry and draft updates do not change the thread; retries still use the choices at the press.
  const latestRetry = useRef(retry);
  latestRetry.current = retry;
  const retryTurn = useCallback((turn: typeof turns[number]) => { void latestRetry.current(turn); }, []);
  const popOut = async () => {
    if (opening.current) return;
    countUse('coord.pip');
    opening.current = true;
    const box = (panel.current ?? card.current)?.getBoundingClientRect();
    try {
      const next = await openPipWindow({ width: Math.round(box?.width ?? FIRST.width), height: Math.round(box?.height ?? FIRST.height) },
        t("coordinatorCard.window"));
      // Taken out of the window before its document goes: what is still in it then is cut off from React's listeners
      // (on these elements), and back on the screen its presses would reach nothing.
      next.addEventListener("pagehide", () => {
        drawn.body.remove(); drawn.end.remove(); drawn.foot.remove();
        setOwn(null);
      }, { once: true });
      setOwn(next);
    } catch (error) { notify.failure(error, { about: "coordinator pop-out", text: t("coordinatorCard.popOutFailed") }); }
    finally { opening.current = false; }
  };
  // What is read stands in the reader's one column (reading-column.ts): as wide as the conversation up to the column, and
  // in the middle of a wider one. The queue opens over the conversation's own area, not the column's.
  const content = <div data-reading-column inert={shownConversation.closing} aria-busy={shownConversation.closing || undefined} className={cn(COLUMN.body, shownConversation.closing && 'opacity-60')}>
    <CoordinatorThread turns={turns} retry={retryTurn} skills={catalog.skills} clock={clock} />
  </div>;
  return <FrameHandContext.Provider value={hand}>
    {/* Folded, the way into the conversation over the input's left end. Kept measurable while hidden, it reserves
        the same room at the top in either state; inert removes it from focus and accessibility while open. */}
    <div ref={entrance} data-coordinator-fold-area inert={!folded} aria-hidden={!folded || undefined}
      className="invisible pointer-events-none fixed z-(--layer-edit-surface) *:visible"
      style={{ display: folded ? undefined : "none", left: "var(--coordinator-left, 12px)", top: ceilingOf(narrow, bar),
        bottom: `calc(var(--coordinator-input-top, 0px) + ${BETWEEN}px)`, width: "var(--coordinator-width, 440px)" }}>
      <div ref={foldRow} data-coordinator-fold-row className="pointer-events-none absolute inset-x-0 bottom-0 flex h-9 items-center gap-2 whitespace-nowrap">
        <LastWordsPill style={{}} />
        {folded && <ThreadQueue area={entrance} folded />}
        {folded && <ParkedReturn folded />}
        {folded && <TaskActionSlot ref={foldTools} className="ml-auto" />}
      </div>
    </div>
    {last && <MentionMarks text={`${last.ask}\n${last.answer ?? ""}`} />}
    {own ? createPortal(<div data-coordinator-card data-coordinator-own-window aria-label={t("coordinatorCard.title")}
      className="flex h-dvh flex-col bg-raised text-base text-ink">
      {/* The conversation's area, over the input: what opens over the conversation is placed from it (ThreadQueue). */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div ref={holdArea} className="relative flex min-h-0 flex-1 flex-col [&>[data-card-scroll]]:min-h-0">
          <div data-card-scroll className={cn(PANE_SCROLL, HEAD_WITH_CONTROLS)}><PanelHead><PopIn own={own} /></PanelHead><div ref={drawn.holdBody} /></div>
        </div>
        <div className={PANE_FOOT}><div ref={drawn.holdEnd} className={END_ROW} /></div>
      </div>
      <div className="contents" ref={drawn.holdFoot} />
      {/* What is done there (a file too large to attach, a copy) is said there too, and only there, in the one place. */}
      <SurfaceDocument value={own.document}><Toaster name="coordinator" /></SurfaceDocument>
    </div>, own.document.body) : <>
      <div ref={card} data-coordinator-card data-coordinator-folded={expanded ? undefined : true} role="region" aria-label={t("coordinatorCard.title")}
        // The input's frame, or its one line, floats by itself (its own edge and shadow). On a computer there is no band
        // round it: what scrolls shows round it and passes behind it, and a press round it reaches what is there. On a
        // phone it stands across the screen's foot on the ground of what it stands over (--foot-ground), from its top
        // (or the open conversation's foot) down: what scrolls ends at its top, not showing in the slips beside and under it.
        className={cn("group/frame pointer-events-none fixed z-(--layer-coordinator-input) flex flex-col text-base text-ink *:pointer-events-auto [&_[data-one-input-area]]:border-0 [&_[data-one-input-area]]:bg-transparent [&_[data-one-input-area]]:p-0 [&_[data-composer-frame]]:shadow-float",
          narrow ? "inset-x-0 bottom-0 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] before:pointer-events-auto before:absolute before:inset-x-0 before:top-0 before:bottom-0 before:-z-10 before:bg-(--foot-ground) before:content-['']"
            : "max-h-[85dvh]", narrow && shown && "before:-top-2")}>
        {/* The composer keeps its draft and sender while the folded controls stand in their row above it. */}
        {open ? <div className="contents" ref={drawn.holdFoot} /> : <CoordinatorCapsule />}
        {/* Folded, the frame's grip is the input's; open, the conversation's (on its head line). */}
        {!narrow && !expanded && <FrameGrip className={frame.edge === "top" ? "top-full mt-3" : "bottom-full mb-3"} />}
      </div>
      {/* The frame's one outline (placeFoot sizes it to the input and the conversation as one): every edge it is sized by,
          each with its one handle, whatever is open. Nothing of it but the edges takes a press. */}
      {!narrow && <div ref={outline} data-frame-outline className="pointer-events-none fixed z-(--layer-coordinator-input)">
        <FrameEdge side="far" edge={frame.edge} /><FrameEdge side="far-left" edge={frame.edge} /><FrameEdge side="far-right" edge={frame.edge} />
        <FrameEdge side="left" edge={frame.edge} /><FrameEdge side="right" edge={frame.edge} />
      </div>}
      {/* The conversation: a surface of its own over the input, with room between them and nothing round it. */}
      {shown && (narrow ? <PhoneSheet ref={panel} data-coordinator-panel data-coordinator-phone role="dialog" aria-label={t("coordinatorCard.title")} label={t("coordinatorCard.height")}
        below={footSize.height + BETWEEN} room={footSize.room} expanded={expanded} onLetGo={() => useConversation.getState().setExpanded(false)}
        className={cn("inset-x-3 z-(--layer-coordinator) origin-bottom rounded-pane border-hairline border-lit-line bg-raised text-base text-ink shadow-float", HEAD_GRIP_ONLY)}>
        <div ref={holdArea} className={cn(AREA_UNDER_HEAD, "min-h-(--pane-head)")}>
          <div data-card-scroll className={PANE_SCROLL}><PanelHead /><div ref={drawn.holdBody} /></div>
        </div>
        <div data-card-grab data-grab-gain="2" className={cn(PANE_FOOT, "touch-none")}><SheetControls /><div ref={drawn.holdEnd} className={END_ROW} /></div>
      </PhoneSheet> : <div ref={panel} role="dialog" aria-label={t("coordinatorCard.title")} data-coordinator-panel
        // Over the input it stands on, as wide and as far left as it, as tall as the frame says (placeFoot writes all
        // four). It is sized by its sides and top, and moved, with the input, by its head line.
        data-frame-edge-end={frame.edge}
        className="group/frame fixed z-(--layer-coordinator) flex max-h-(--coordinator-panel-room) origin-bottom flex-col text-base text-ink transition-opacity duration-150 data-frame-let-go:opacity-50 data-[frame-edge-end=top]:origin-top">
        {/* The surface owns a scrolling body and a fixed end row; its still copy keeps the same structure. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-pane border-hairline border-lit-line bg-raised shadow-float">
          <div ref={holdArea} className={AREA_UNDER_HEAD}>
            <div data-card-scroll className={cn(PANE_SCROLL, HEAD_WITH_CONTROLS)}><div data-card-content><PanelHead grip><PaneHeadControls maximize={{ maximized, toggle: toggleMaximized }} edge={frame.edge} popOut={documentPip() ? () => void popOut() : undefined} /></PanelHead><div ref={drawn.holdBody} /></div></div>
          </div>
          <div className={PANE_FOOT}><div ref={drawn.holdEnd} className={END_ROW} /></div>
        </div>
      </div>)}
    </>}
    {createPortal(<SurfaceDocument value={own?.document ?? null}>{content}</SurfaceDocument>, drawn.body)}
    {createPortal(<SurfaceDocument value={own?.document ?? null}><ThreadEnd active={expanded || !!own} area={threadArea} /></SurfaceDocument>, drawn.end)}
    {footer}
  </FrameHandContext.Provider>;
}

/** The ask key `/` brings the input up, serve in reach or not: writing is the device's own, only sending waits for serve. */
export function useCoordinatorShortcut() {
  const writable = useWorkspaceWritable();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!writable || event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      event.preventDefault(); focusCoordinator();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [writable]);
}
