/**
 * A test's screen tree: every active project's control tree (helpers/control-tree) joined as one, as the whole read
 * served it before serve projected Task by Task. A project's read holds its own Tasks and the
 * project Tasks their settings and paths need; each project's own row, schema and values come from its own read, which is
 * read again whenever it or a project above it changes.
 */
import { ProjectShelf, readProjectShelf } from '@alpacawork/backend/test-dist/control/project-shelf.js';
import { readControlEnvironment } from '@alpacawork/backend/test-dist/control/tree.js';
import { byTaskNumber } from '@alpacawork/contract/moved';
import type { ControlTreeDTO } from '@alpacawork/contract/control';

/** One active project as the screen lists it: after the project it is in, in creation order, `depth` 0 at the top. */
type ScreenProject = { id: string; title: string; parentId: string | null; depth: number; color: string; cwd: string | null };
type ScreenEnvironment = Pick<ControlTreeDTO, 'root' | 'profiles' | 'attachmentBytes' | 'errors' | 'writable'> & { shelf: ProjectShelf };
export function readScreenEnvironment(root: string): ScreenEnvironment {
  return { ...readControlEnvironment(root), shelf: readProjectShelf(root) };
}
export type ScreenTree = ControlTreeDTO & { projects: ScreenProject[]; projectShelfVersion: string;
  /** Execution evidence can require review without making the authoritative Task read incomplete. */
  runIssues?: ControlTreeDTO['errors'] };

/** Each part is one project's read, named by its project Task; this PC's facts (root, profiles) are the same in each. */
export function screenTree(environment: ScreenEnvironment, input: readonly { project: string; tree: ControlTreeDTO }[], locations: Readonly<Record<string, string>> = {}): ScreenTree {
  const parts = input.filter(part => environment.shelf.listed.has(part.project));
  const trees = parts.map(part => part.tree);
  // A read's own Tasks are its project's and the project itself; the project Tasks above come with every read.
  const owned = parts.map(({ project, tree }) => {
    const tasks = tree.tasks.filter(task => task.kind === 'task' || task.id === project);
    const ids = new Set(tasks.map(task => task.id));
    return { tasks, dialogues: tree.dialogues.filter(dialogue => ids.has(dialogue.taskId)) };
  });
  const own = new Map(parts.flatMap(({ project, tree }) => tree.tasks.filter(task => task.id === project)
    .map(task => [task.id, task] as const)));
  const projects: ScreenProject[] = [];
  const list = (parentId: string | null, depth: number) => {
    for (const task of [...own.values()].filter(task => (task.parentId !== null && own.has(task.parentId)
      ? task.parentId : null) === parentId).sort(byTaskNumber)) {
      projects.push({ id: task.id, title: task.title, parentId: task.parentId, depth,
        color: task.settings!.color, cwd: locations[task.id] ?? null });
      list(task.id, depth + 1);
    }
  };
  list(null, 0);
  return { root: environment.root, profiles: environment.profiles, attachmentBytes: environment.attachmentBytes,
    projectShelfVersion: environment.shelf.revision,
    tasks: owned.flatMap(part => part.tasks),
    placements: trees.flatMap(tree => tree.placements), runs: trees.flatMap(tree => tree.runs),
    requests: trees.flatMap(tree => tree.requests),
    replies: Object.assign({}, ...trees.map(tree => tree.replies)), balls: Object.assign({}, ...trees.map(tree => tree.balls)),
    working: trees.some(tree => tree.working === null) ? null : [...new Set(trees.flatMap(tree => tree.working!))],
    historyFacts: { answerTexts: Object.assign({}, ...trees.map(tree => tree.historyFacts.answerTexts)),
      placementRoles: Object.assign({}, ...trees.map(tree => tree.historyFacts.placementRoles)),
      runRoles: Object.assign({}, ...trees.map(tree => tree.historyFacts.runRoles)),
      deliveries: trees.flatMap(tree => tree.historyFacts.deliveries),
      coordinatorRuns: Object.assign({}, ...trees.map(tree => tree.historyFacts.coordinatorRuns)) },
    dialogues: owned.flatMap(part => part.dialogues),
    requestedByUser: Object.assign({}, ...trees.map(tree => tree.requestedByUser)),
    startOrder: Object.assign({}, ...trees.map(tree => tree.startOrder ?? {})),
    // The workspace's fields are the same in every read; a project's schema and values come from its own read.
    fieldCatalog: trees[0]?.fieldCatalog ?? [],
    projectSchemas: Object.fromEntries(parts.flatMap(({ project, tree }) =>
      Object.entries(tree.projectSchemas).filter(([id]) => id === project))),
    taskValues: Object.fromEntries(parts.flatMap(({ tree }, index) => owned[index]!.tasks.map(task =>
      [task.id, tree.taskValues[task.id] ?? {}]))),
    // A fault of the shared database or of this PC's settings is reported by every project's read; it is one fault.
    errors: [...new Map([...environment.errors, ...trees.flatMap(tree => tree.errors)].map(error => [JSON.stringify(error), error])).values()],
    writable: environment.writable && trees.every(tree => tree.writable),
    projects };
}
