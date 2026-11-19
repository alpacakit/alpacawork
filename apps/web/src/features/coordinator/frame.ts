import { deviceValue, jsonCodec } from "@/lib/device-storage";

/*
 * Where the coordinator stands on a computer: its input and the conversation with it, moved and sized as one.
 *
 * One rule, the same across and up and down. It stands by the nearer side of the screen's working room (left or
 * right) and by the nearer end (`edge`: the top or the foot), and grows away from them. Not put anywhere yet, it
 * stands in the middle across (`center`), at the foot, under what is read: where the eye and the hand already are. the input grows away from its
 * end as more is written, and the conversation opens on the input's far side (by the foot it opens over the input, by
 * the top under it), so opening it never moves the input. What is kept is that (`Frame`): how far from that side and
 * that end the input stands, how wide both are, and how tall the conversation is. What is drawn is that held inside the
 * working room as it is now (`placeFrame`): the window left of the panel at its right edge (`besidePanel`), less the app's bar and the
 * conversation's entrance over the input, less the keyboard at the foot (the visual viewport). The bar and the entrance
 * are the input's to keep clear: the conversation open over the input reaches the window's top (`reach`), over the
 * bar (a window the hand made that tall) and over the entrance (hidden while it is open). Holding it in never changes what is kept,
 * so a window made smaller and large again, the reader or a file opened and closed, or the keyboard up and down, puts it back
 * where it was. Only where the room has not the conversation's height on the far side is the whole drawn nearer its
 * end's opposite, and the conversation as tall as what is left.
 *
 * It is never wider than what is read in it (`widest`): wider would only add empty room round the reading column.
 * A side pulled on past that gives a little, less the further it is pulled (`pulledOut`), and goes back when let go:
 * what is kept is never past it (`keptWithin`).
 */

/** The end of the working room it stands by: the input is on that side of the conversation. */
export type Edge = "top" | "bottom";
/**
 * What is kept: `x` from the nearer side (none in the middle), `y` from the nearer end to the input's near edge, the
 * width, and the conversation's height.
 */
export type Frame = { side: "left" | "center" | "right"; x: number; edge: Edge; y: number; width: number; height: number };
/**
 * The working room, in the window's coordinates: what the coordinator may cover (`top`, where the input may stand, under
 * the bar and the entrance; `reach`, the highest the conversation open over it goes); and `widest`, the most it is
 * across: the reading column at its widest (reading-column.ts) with its surface's edges.
 */
export type Room = { left: number; right: number; top: number; reach: number; bottom: number; widest: number };
/** What is drawn: the input's left edge, width, top and foot (from the window's top), and the conversation's height. */
export type Placed = { left: number; width: number; edge: Edge; top: number; foot: number; height: number };
/** A side the hand holds, and how wide it asks the frame to be. */
export type Pull = { side: "left" | "right"; wanted: number };

/**
 * The least room between the coordinator and the sides and foot of its working room, and how far under the window's top
 * the conversation reaches (its top keeps its own): a window's margin (--spacing-window), as the reader's, so maximized
 * beside it the two stand on the same top and foot.
 */
export const EDGE = 12;
/**
 * How far under the window's top the input and its entrance stand, under the bar too: on a computer the window's margin
 * (EDGE, as the reader's); a phone's sheet keeps its own 8px under the bar.
 */
export const ceilingOf = (narrow: boolean, bar: number) => (narrow ? 8 : EDGE) + bar;
/** Put down nearer a side or an end than this, it goes to where it stands from there (SIDE, FIRST.y). */
export const SNAP = 28;
/**
 * The room between two surfaces floating at the foot, each on its own: the conversation and the input, and the row over
 * the input (the conversation's news, the task's moves) and the input, the same on a phone and a computer. It is a step
 * closer than EDGE at the sides, so what stands over the input reads as one stack with it; on a phone with no safe
 * area at its foot, it is as far from the input as the input is from the foot (CoordinatorCard's 0.5rem).
 */
export const BETWEEN = 8;
/** How far from a side it stands put by it (snapped, or sized out to it). */
export const SIDE = 16;
/** Narrower, the input's own moves (attach, #, /, the model, send) no longer fit on its one row. */
export const LEAST_WIDTH = 340;
/**
 * Lower, the conversation shows little more than its head line: its head (48px) and foot over one line of the thread
 * clear of the 16px each of them fades over (parts.css pane-head-fade, pane-foot-fade).
 */
export const LEAST_HEIGHT = 152;
/** The most a side gives past the widest, however far it is pulled; and how far it is pulled for most of that. */
const GIVE = 28, GIVE_PULL = 90;
/** Where it first stands: in the middle across, at the foot, 600px wide (held within its widest and the room). */
export const FIRST: Frame = { side: "center", x: 0, edge: "bottom", y: 12, width: 600, height: 400 };
/**
 * The frame drawn at `placed` maximized in `room`, the room the hand sizes it in: as large as the hand can size it
 * from there (`sized` in frame-hand.tsx meets the same limits): as wide as it goes (`widthWithin`) within what its sides
 * reach (`reachAcross`), grown away from the side it stands by, and the conversation as tall as the room has it on the
 * input's far side (`tallest`), the input `inputAt` tall at that width (what is written in it wraps anew). The input
 * stays by its end where it is drawn. Maximized, that is what is kept (`keptAt`), as if the hand had pulled it so: the
 * hand sizes and moves it on from there.
 */
export function placeMaximized(placed: Placed, room: Room, inputAt: (width: number) => number = () => placed.foot - placed.top): Placed {
  const reach = reachAcross(placed, room), width = Math.min(widthWithin(Infinity, room), reach.right - reach.left);
  const byRight = room.right - placed.left - placed.width < placed.left - room.left;
  const left = Math.round(clamp(byRight ? placed.left + placed.width - width : placed.left, reach.left, reach.right - width));
  const input = inputAt(width), at = placed.edge === "bottom" ? { top: placed.foot - input, foot: placed.foot } : { top: placed.top, foot: placed.top + input };
  const wide = { ...placed, ...at, left, width };
  return { ...wide, height: tallest(wide, room) };
}
/** Whether `placed` is as large as the hand can size it in `room` (placeMaximized), to the pixel. */
export function atLargest(placed: Placed, room: Room) {
  const most = placeMaximized(placed, room);
  return Math.abs(most.width - placed.width) <= 1 && Math.abs(most.height - placed.height) <= 1;
}

const frameCodec = jsonCodec<Frame | null>((value) => {
  const frame = value as Frame | null;
  if (!frame || !["left", "center", "right"].includes(frame.side) || (frame.edge !== "top" && frame.edge !== "bottom")) return null;
  if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) return null;
  // Kept lower than the least it can now be sized to, it is read as that least.
  return frame.height < LEAST_HEIGHT ? { ...frame, height: LEAST_HEIGHT } : frame;
});
export const keptFrame = deviceValue<Frame | null>("alpacawork.coordinatorFrame", frameCodec, null);
/** The last frame kept smaller than its largest: what the head's ↙↗ puts back (unset: where it first stands). */
export const smallerFrame = deviceValue<Frame | null>("alpacawork.coordinatorFrameSmaller", frameCodec, null);

const clamp = (value: number, least: number, most: number) => Math.max(least, Math.min(value, most));
/** The room's sides less EDGE, and its foot; its top is already clear (the bar and the conversation's entrance keep their own room). */
const inner = (room: Room) => ({ left: room.left + EDGE, right: room.right - EDGE, top: room.top, bottom: room.bottom - EDGE });
/** The most it is across in `room`: its widest, or the room less its EDGE where that is narrower. */
const across = (room: Room) => Math.min(room.widest, room.right - room.left - 2 * EDGE);

/**
 * The frame drawn in `room`, with the input `input` tall and the conversation `open` or not. Too narrow a room narrows
 * it; too low a room for the conversation on the input's far side draws the whole further that way, to the room's
 * other end, and the conversation as tall as what is left.
 */
export function placeFrame(frame: Frame, room: Room, input: number, open: boolean): Placed {
  const at = inner(room);
  // As wide as the hand made it, up to its widest and the room; the room's far side come in, it narrows where it stands
  // down to its least, as far from that side as it stands from a side put by one (SIDE, as the hand sizes it), and
  // only then is moved. In the middle, it narrows from both sides.
  const from = room.right - room.left - SIDE - (frame.side === "center" ? SIDE : frame.x);
  const width = widthWithin(Math.min(frame.width, Math.max(LEAST_WIDTH, from)), room);
  const want = frame.side === "center" ? (room.left + room.right - width) / 2 : frame.side === "left" ? room.left + frame.x : room.right - frame.x - width;
  // Moved in from a side, it stops SIDE from it; where the room has not that, at the room's edge.
  const most = room.right - SIDE - width, least = room.left + SIDE;
  const left = Math.round(most >= least ? clamp(want, least, most) : clamp(want, at.left, at.right - width));
  const over = open ? BETWEEN + frame.height : 0;
  if (frame.edge === "bottom") {
    const foot = Math.round(Math.min(at.bottom, Math.max(room.bottom - frame.y, at.top + input, room.reach + over + input)));
    const height = Math.round(Math.max(0, Math.min(frame.height, foot - input - BETWEEN - room.reach)));
    return { left, width, edge: "bottom", top: foot - input, foot, height };
  }
  const top = Math.round(Math.max(at.top, Math.min(room.top + frame.y, at.bottom - input - over)));
  const height = Math.round(Math.max(0, Math.min(frame.height, at.bottom - top - input - BETWEEN)));
  return { left, width, edge: "top", top, foot: top + input, height };
}

/**
 * The room a frame stands in where a panel stands at the window's right edge from `panel` (its left edge): the docked
 * reader, or the file or diff read beside it while the reader stands on the window's left (Workbench's
 * data-view-beside). The frame never covers that panel; it stands left of it, over what is there (the list, or the
 * reader moved left), as the panel stands from the window's edge (EDGE: the room reaches under the panel so far that a
 * frame SIDE from its edge is EDGE from the panel), narrowing where it stands as the panel widens and then moving
 * towards the window's left (placeFrame). The panel never takes the room a frame needs at its least width by the
 * window's left: widened past that, the panel goes over it. The room is the same however the hand holds the frame, so it
 * moves, sizes and maximizes it in one room.
 */
export function besidePanel(room: Room, panel: { left: number } | null): Room {
  if (!panel) return room;
  return { ...room, right: Math.min(room.right, Math.max(panel.left + SIDE - EDGE, room.left + LEAST_WIDTH + 2 * SIDE)) };
}

/** Of the panels docked on the page (the reader, and a file or diff read beside it), the one at the window's right edge. */
export const atRight = <Panel extends { left: number }>(panels: Panel[]): Panel | null =>
  panels.reduce<Panel | null>((most, each) => !most || each.left > most.left ? each : most, null);

/**
 * Whether the panel at the window's right (besidePanel) pushes the frame: the person holds the reader's edge
 * (`held`), and the panel's left edge (`left`) has come further in than when the frame was last placed (`was`,
 * undefined while there was no panel). Nothing else pushes it: the window sized, the type size changed, a panel opened,
 * or a width asked of it that it cannot take.
 */
export const pushingPanel = (held: boolean, left: number, was: number | undefined) => held && was !== undefined && left < was;

/**
 * Standing in the middle or by the right of its room, and pushed by the panel (pushingPanel) once the room has narrowed
 * it to its least (placeFrame) and moved it to the room's left, it stands by the left from then on (what is kept, as
 * if the hand had put it there): the panel narrowed again, it stays there and widens away from it, as far as it was
 * kept wide, leaving room by the panel. Only narrowed, it is not pushed: the panel given back its room, it is where it
 * was. Null where it is not so pushed.
 */
export function pushedAcross(frame: Frame, placed: Placed, room: Room, pushed: boolean): Frame | null {
  if (!pushed || frame.side === "left" || placed.width > LEAST_WIDTH) return null;
  return placed.left - room.left <= SIDE ? keptWithin({ ...frame, side: "left", x: SIDE }, room) : null;
}

/** The end of the room the input at `top`..`foot` is nearer. */
export const nearerEdge = (top: number, foot: number, room: Room): Edge => top - room.top < room.bottom - foot ? "top" : "bottom";

/**
 * What to keep for an input drawn from `top` to `foot` (and `left`, `width`) in `room`, standing by `edge`: measured
 * from the nearer side and from that end, so it stays by them as the room changes. Within SNAP of either it goes to
 * where it first stands from there.
 */
export function frameAt(at: { left: number; width: number; top: number; foot: number }, room: Room, edge: Edge, height: number): Frame {
  const fromLeft = at.left - room.left, fromRight = room.right - at.left - at.width;
  const side = fromLeft < fromRight ? "left" : "right";
  const x = Math.round(side === "left" ? fromLeft : fromRight);
  const y = Math.round(edge === "bottom" ? room.bottom - at.foot : at.top - room.top);
  return { side, x: x < SNAP ? SIDE : x, edge, y: y < SNAP ? (edge === "bottom" ? FIRST.y : 0) : y,
    width: Math.round(at.width), height: Math.round(height) };
}

/**
 * What to keep for `placed` sized from `kept`: up and down where `kept` stands from its end (sizing never moves it so),
 * and across where it is drawn (not snapped again, which would move the side not held).
 */
export function keptAt(placed: Placed, room: Room, kept: Frame): Frame {
  const frame = frameAt(placed, room, kept.edge, placed.height);
  return { ...frame, x: Math.round(frame.side === "left" ? placed.left - room.left : room.right - placed.left - placed.width), y: kept.y };
}

/** A width the hand asks for, held between the least and the most (its widest, and the room). */
export function widthWithin(width: number, room: Room) {
  return Math.round(clamp(width, Math.min(LEAST_WIDTH, room.right - room.left - 2 * EDGE), across(room)));
}

/** What is kept of `frame` in `room`: never wider than its widest there, however it was asked for. */
export const keptWithin = (frame: Frame, room: Room): Frame => frame.width > room.widest ? { ...frame, width: room.widest } : frame;

/**
 * `placed` drawn with the side the hand holds given way as it pulls: only where it is drawn at its widest (not where the
 * room stops it short of that), less the further past it the hand goes, and inside the room.
 */
export function pulledOut(placed: Placed, { side, wanted }: Pull, room: Room): Placed {
  const past = wanted - room.widest;
  if (past <= 0 || placed.width < room.widest) return placed;
  const by = Math.round(GIVE * (1 - Math.exp(-past / GIVE_PULL))), at = inner(room);
  if (side === "right") return { ...placed, width: Math.min(placed.width + by, at.right - placed.left) };
  const left = Math.max(at.left, placed.left - by);
  return { ...placed, left, width: placed.width + placed.left - left };
}

/**
 * How far the sides of a frame drawn at `placed` reach as the hand sizes it: to where it stands put by the room's
 * sides (SIDE), never pulling in a side that already stands further out.
 */
export const reachAcross = (placed: Placed, room: Room) =>
  ({ left: Math.min(room.left + SIDE, placed.left), right: Math.max(room.right - SIDE, placed.left + placed.width) });

/** The most the conversation can be on the far side of an input drawn at `placed`. */
export const tallest = (placed: Placed, room: Room) =>
  Math.max(0, placed.edge === "bottom" ? placed.top - BETWEEN - room.reach : inner(room).bottom - placed.foot - BETWEEN);
