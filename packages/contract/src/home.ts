/**
 * Browser-safe: the home list as the server projects it. Its rows, sections and counts are made in one place
 * (index-feed's homeRows); the screen draws them and derives none of them.
 */
import { z } from 'zod';
import { taskIdSchema } from './fields.js';
import { userTurn, type Ball } from './ball.js';
import { isFinished } from './finished-branch.js';
import type { TaskBaseState } from '@alpacawork/raw';

/** Working, Error, Awaiting review, Idle, Not started, Held, Done. */
export const HOME_SECTIONS = ['doing', 'error', 'review', 'awaited', 'todo', 'held', 'done'] as const;
export const taskActionSchema = z.enum(['report_doing', 'report_done', 'submit_review', 'confirm', 'stop', 'resume', 'hold', 'unhold']);
const countSchema = z.number().int().nonnegative();
export const homeRowSchema = z.object({
  taskId: taskIdSchema, section: z.enum(HOME_SECTIONS),
  /** Children finished of all children. */
  summary: z.object({ done: countSchema, total: countSchema }).strict(),
}).strict();
/**
 * How many rows each section lists in one scope, counted from the rows. Done is not among them: its rows come in
 * closed pages, which the index counts with those pages.
 */
export const homeCountsSchema = z.object({ doing: countSchema, error: countSchema, review: countSchema, awaited: countSchema, held: countSchema, todo: countSchema })
  .strict();

export type HomeSection = typeof HOME_SECTIONS[number];
const TURN_SECTION: Readonly<Record<Extract<Ball, { holder: 'user' }>['reason'], 'review' | 'error'>> = {
  review: 'review', question: 'review', failed: 'error', limit: 'error', unconfirmed: 'error', blocked: 'error',
};
type HomeTask = { id: string; parentId: string | null; kind: string; lifecycle: string;
  baseState: TaskBaseState; hold: boolean; summary: { done: number; total: number } };
/** `shown`: a row above it, the nearest doing row among its ancestors, already lists its work in the doing section. */
type HomeFacts = { top: boolean; hold: boolean; baseState: TaskBaseState;
  turn: Extract<Ball, { holder: 'user' }>['reason'] | null; working: boolean; shown: boolean };
/**
 * First matching rule wins. These rules select rows, never Task state or whose turn it is. Work running anywhere is
 * listed in the doing section exactly once: on the highest Task no doing row above already lists it (L00), so a
 * subtask works on its own row while its parent awaits review, is held or failed, and on its parent's while that works.
 */
const HOME_RULES: readonly { id: string; when: (f: HomeFacts) => boolean; section: (f: HomeFacts) => HomeSection | null }[] = [
  { id: 'L00', when: f => !f.top && f.turn === null && f.working && !f.shown, section: () => 'doing' },
  { id: 'L01', when: f => !f.top && f.turn === null, section: () => null },
  { id: 'L02', when: f => !f.top, section: f => TURN_SECTION[f.turn!] },
  { id: 'L03', when: f => f.hold, section: () => 'held' },
  { id: 'L04', when: f => f.turn !== null, section: f => TURN_SECTION[f.turn!] },
  { id: 'L05', when: f => f.baseState === 'error', section: () => 'error' },
  { id: 'L06', when: f => f.baseState === 'waiting', section: () => 'review' },
  { id: 'L07', when: f => f.baseState === 'todo', section: () => 'todo' },
  { id: 'L08', when: f => isFinished(f.baseState), section: () => 'done' },
  { id: 'L09', when: f => f.working, section: () => 'doing' },
  { id: 'L10', when: () => true, section: () => 'awaited' },
];

/** One pass through the tree propagates work through every active depth, including held children.
 * Projects and inactive branches stop propagation. Rows retain the input order; cycles are a fault. */
export function projectHome(tasks: readonly HomeTask[], balls: Readonly<Record<string, Ball>>, working: ReadonlySet<string>):
  z.infer<typeof homeRowSchema>[] {
  return placeHome(tasks, balls, working).flatMap(({ row }) => row ? [row] : []);
}
/**
 * projectHome with, for each active Task, whether a doing row (its own or one above) lists the work on and below it:
 * the fact the Tasks below it read, so only a change to it reaches them.
 */
export function placeHome(tasks: readonly HomeTask[], balls: Readonly<Record<string, Ball>>, working: ReadonlySet<string>):
  { taskId: string; row: z.infer<typeof homeRowSchema> | null; listsWork: boolean }[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const children = new Map<string | null, HomeTask[]>();
  for (const task of tasks) {
    const parent = task.parentId !== null && byId.has(task.parentId) ? task.parentId : null;
    const group = children.get(parent) ?? [];
    group.push(task); children.set(parent, group);
  }
  const visited = new Set<string>(), work = new Set<string>();
  const stack = (children.get(null) ?? []).map(task => ({ task, exit: false }));
  while (stack.length) {
    const { task, exit } = stack.pop()!;
    if (!exit) {
      if (visited.has(task.id)) throw new Error(`Cyclic home tree: ${task.id}`);
      visited.add(task.id);
      stack.push({ task, exit: true });
      for (const child of children.get(task.id) ?? []) stack.push({ task: child, exit: false });
    } else if (task.lifecycle === 'active' && task.kind === 'task' &&
      (working.has(task.id) || (children.get(task.id) ?? []).some(child => work.has(child.id)))) work.add(task.id);
  }
  if (visited.size !== tasks.length) throw new Error('Cyclic home tree');
  // Each active Task's section and whether its work is listed, from the top down (a row's section reads the rows above).
  const placed = new Map<string, { section: HomeSection | null; listsWork: boolean }>();
  const place = (task: HomeTask): { section: HomeSection | null; listsWork: boolean } => {
    const known = placed.get(task.id);
    if (known) return known;
    const parent = task.parentId === null ? undefined : byId.get(task.parentId);
    const top = !parent || parent.kind !== 'task' || parent.lifecycle !== 'active';
    const shown = !top && place(parent).listsWork;
    const facts: HomeFacts = { top, baseState: task.baseState, hold: task.hold,
      turn: userTurn(balls[task.id] ?? null)?.reason ?? null, working: work.has(task.id), shown };
    const section = HOME_RULES.find(rule => rule.when(facts))!.section(facts);
    const result = { section, listsWork: shown || section === 'doing' };
    placed.set(task.id, result);
    return result;
  };
  return tasks.flatMap(task => {
    if (task.kind !== 'task' || task.lifecycle !== 'active') return [];
    const { section, listsWork } = place(task);
    return [{ taskId: task.id, row: section === null ? null : { taskId: task.id, section, summary: { ...task.summary } }, listsWork }];
  });
}

/**
 * The home list after a patch's changes: rows it removes or moves leave, and each changed row goes right after the row
 * it names (`after`: null for the first), whether that row is kept or is itself among the changed ones, in any order
 * the patch lists them. The kept rows keep their order. Null when a named row is not in the result: the list held is not
 * the one the patch follows, and the whole list has to be read again.
 */
export function placeHomeRows<R extends { readonly taskId: string }>(home: readonly R[],
  change: { readonly upsert: readonly { readonly row: R; readonly after?: string | null }[]; readonly remove: readonly string[] }): R[] | null {
  const moved = new Set([...change.remove, ...change.upsert.map(each => each.row.taskId)]);
  const following = new Map<string | null, R[]>();
  for (const { row, after = null } of change.upsert) following.set(after, [...following.get(after) ?? [], row]);
  const out: R[] = [];
  const placeAfter = (id: string | null) => {
    const stack = [...following.get(id) ?? []].reverse(); following.delete(id);
    while (stack.length) {
      const row = stack.pop()!; out.push(row);
      const next = following.get(row.taskId);
      if (next) { following.delete(row.taskId); stack.push(...[...next].reverse()); }
    }
  };
  placeAfter(null);
  for (const row of home) if (!moved.has(row.taskId)) { out.push(row); placeAfter(row.taskId); }
  return following.size ? null : out;
}
