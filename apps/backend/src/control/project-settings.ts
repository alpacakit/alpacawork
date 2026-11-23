/**
 * The rules of project-type Tasks' settings. A Task inherits its code location on this PC from the nearest project that
 * sets one ('' is set on purpose and turns it off), naming the project it came from. Its launches carry each project's
 * summary and policy from the root down. A Task created without a parent goes under the project whose code location holds the
 * caller's cwd. A project's title, values and settings column are its Task's own; this PC's code locations are
 * config.yaml's `projects` section, which only `writeProjectLocation` writes.
 */
import { projectShelfIn } from './project-shelf.js';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { CONFIG_FILE, digest, validateTaskSettings, type ProjectSettings, type TaskKind } from '@alpacawork/raw';
import { DEFAULT_PROJECT_NAME, PROJECT_POLICY, PROJECT_SUMMARY } from '@alpacawork/contract';
import type { BranchTask } from '@alpacawork/contract/branch';
import { parseConfig, projectLocationsSchema } from '../config.js';
import { FileWriter } from '../raw/storage.js';
import { requirePublished, FileJournal } from './file-journal.js';
import { launchDirectory } from './launch-directory.js';
import { TaskTree } from './task-store.js';
import type { TaskContexts } from './task-context.js';

/** What these rules read of a Task: its kind and title, and a project-type Task's own settings (null for none). */
type SettingsTask = { id: string; meta: BranchTask & { kind: TaskKind; title: string }; settings: ProjectSettings | null };
/** What a policy chain reads of a Task besides its context: its kind, title and lifecycle. */
type ChainTask = { id: string; meta: BranchTask & { kind: TaskKind; title: string } };
function read<T>(root: string, work: (db: DatabaseSync) => T): T {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { return store.read(work); } finally { store.close(); }
}
/**
 * This PC's code locations by project-type Task, for a decision (where a Run starts, which project a cwd names): busy
 * while a save of config.yaml is pending, so nothing acts on a location that is about to change.
 */
export function projectLocations(root: string): Record<string, string> {
  new FileJournal(root).assertAvailable(CONFIG_FILE);
  return publishedProjectLocations(root);
}
/**
 * The code locations config.yaml holds now, for the screen to show beside the agents it reads from the same file
 * (readAgentsSettings): a pending save shows once it is published. An unreadable config.yaml has none; its readers
 * report that error themselves.
 */
export function publishedProjectLocations(root: string): Record<string, string> {
  let writer: FileWriter | undefined;
  try {
    writer = new FileWriter(root);
    const bytes = writer.read(CONFIG_FILE);
    if (!bytes) return {};
    const projects = parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).values.projects ?? {};
    return Object.fromEntries(Object.entries(projects).map(([id, value]) => [id, value.cwd]));
  } catch { return {}; } finally { writer?.close(); }
}

/**
 * The code location `taskId` inherits from the projects it is in (`TaskTree.projects`), nearest first: that of the first
 * one with a key in `locations` ('' is none: the data directory), and the project it came from; null when none sets one.
 */
export function inheritedLocation<T extends SettingsTask>(tree: TaskTree<T>, locations: Readonly<Record<string, string>>,
  taskId: string): { value: string | null; from: string | null } {
  const located = [...tree.projects(taskId)].reverse().find(project => Object.hasOwn(locations, project.id));
  return { value: located === undefined ? null : locations[located.id] || null, from: located?.id ?? null };
}
/**
 * The project-type Tasks alone, as a tree, and the project `taskId` inherits from: itself when it is a project, else
 * the project it belongs to. A project inherits only from projects, so no other Task is read.
 */
function projectTree(db: DatabaseSync, taskId: string): { tree: TaskTree<SettingsTask>; start: string } {
  const task = db.prepare(`SELECT t.kind, owner.external_id AS project FROM tasks t
    LEFT JOIN tasks owner ON owner.id = t.project_task_id WHERE t.external_id = ?`).get(taskId);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  const projects = db.prepare(`SELECT t.external_id AS id, parent.external_id AS parent_id, t.lifecycle, t.state, t.title,
    t.settings FROM tasks t LEFT JOIN tasks parent ON parent.id = t.parent_id WHERE t.project_task_id IS NULL ORDER BY t.number`)
    .all().map(row => {
      const id = String(row.id);
      return { id, settings: validateTaskSettings('project', row.settings === null ? null : JSON.parse(String(row.settings))),
        meta: { id, kind: 'project' as const, parentId: row.parent_id === null ? null : String(row.parent_id),
          title: String(row.title), lifecycle: String(row.lifecycle) as BranchTask['lifecycle'],
          state: String(row.state) as BranchTask['state'] } };
    });
  return { tree: new TaskTree(projects), start: task.kind === 'project' ? taskId : String(task.project) };
}
/**
 * The code locations this PC keeps for every project `taskId` is in, each one's own ('' is none), in no order that
 * matters: the places a file named in its Task's words may be read from (code-files.ts).
 */
export function chainLocations(root: string, taskId: string): string[] {
  const locations = projectLocations(root);
  return read(root, db => {
    const { tree, start } = projectTree(db, taskId);
    return [...tree.projects(start)].flatMap(project => locations[project.id] ? [locations[project.id]!] : []);
  });
}
/** Where a new conversation of `taskId` starts: the code location it inherits on this PC, else the data directory. */
export function launchCwd(root: string, db: DatabaseSync, taskId: string): string {
  const { tree, start } = projectTree(db, taskId);
  const cwd = inheritedLocation(tree, projectLocations(root), start);
  return cwd.value === null ? root : launchDirectory(root, cwd.value, `${CONFIG_FILE} projects.${cwd.from}.cwd`);
}

/** Active project-type Tasks with a code location of their own on this PC, newest first ('' is none). */
export function ownLocations(root: string, db: DatabaseSync): { id: string; cwd: string }[] {
  const locations = projectLocations(root), listed = projectShelfIn(db).listed;
  return db.prepare("SELECT external_id FROM tasks WHERE project_task_id IS NULL AND lifecycle = 'active' ORDER BY number DESC").all()
    .flatMap(row => {
      const id = String(row.external_id), cwd = locations[id];
      return cwd && listed.has(id) ? [{ id, cwd }] : [];
    });
}
/**
 * The project the cwd rule gives a command that names no Task: the active project whose own code location on this PC
 * holds `cwd`, the deepest one (two at the same place are ambiguous and refused); else the only active project; else
 * none. Nothing else is guessed. A refusal names `option`, the command's own flag for the Task left out.
 */
export function projectAtCwd(root: string, db: DatabaseSync, cwd: string | null, option: 'parent' | 'task'): string | null {
  const holding = cwd === null ? [] : ownLocations(root, db).flatMap(project => {
    let real: string;
    try { real = realpathSync(project.cwd); } catch { return []; }
    return cwd === real || cwd.startsWith(real.endsWith(sep) ? real : real + sep) ? [{ id: project.id, length: real.length }] : [];
  }).sort((a, b) => b.length - a.length);
  const [deepest, next] = holding;
  if (deepest && next && deepest.length === next.length)
    throw new Problem(PROBLEM_CODE.invalidInput, `Projects ${holding.filter(item => item.length === deepest.length)
      .map(item => item.id).join(', ')} share this code location; use --${option} <ID>`, undefined,
      { reason: { kind: 'projects_share_code_location_use_id', holding: String(holding.filter(item => item.length === deepest.length)
      .map(item => item.id).join(', ')), option: String(option) } });
  if (deepest) return deepest.id;
  const [only, other] = [...projectShelfIn(db).listed];
  return only && !other ? only : null;
}
/**
 * The parent of a Task created without one: the cwd rule's project (`projectAtCwd`). Where it gives none, none or
 * several projects are active and the command must name the parent; a refusal names `option`, its flag for it.
 */
export function defaultParentAt(root: string, db: DatabaseSync, cwd: string | null, option: 'parent' | 'task'): string {
  const project = projectAtCwd(root, db, cwd, option);
  if (project !== null) return project;
  const active = projectShelfIn(db).listed.size > 0;
  throw new Problem(PROBLEM_CODE.invalidInput, active ? `Several projects are active: use --${option} <ID>, or run inside a ` +
    'project\'s code location (alpacawork task list --kind project)' : `No project is active: use --${option} <ID>`, undefined,
    { reason: (active ? { kind: 'several_projects_active_use_id_or_run_inside_project_s_code_location_alpacawork_task_list_kind_project', option: String(option) } : { kind: 'no_project_active_use_id', option: String(option) }), issues: [{ path: option, code: 'required', message: `--${option} is required` }] });
}

/** One project's part of the policy chain: its title, summary and policy. */
type PolicyLink = { project: string; title: string; summary: string; policy: string };
/**
 * The policy chain of `taskId`: its projects from the root down that have a summary or a policy.
 */
export function policyChain<T extends ChainTask>(tree: TaskTree<T>, contexts: TaskContexts, taskId: string): PolicyLink[] {
  return tree.projects(taskId).flatMap(project => {
    const values = contexts.valuesOf(project.id);
    const summary = typeof values[PROJECT_SUMMARY] === 'string' ? values[PROJECT_SUMMARY] : '';
    const policy = typeof values[PROJECT_POLICY] === 'string' ? values[PROJECT_POLICY] : '';
    return summary || policy ? [{ project: project.id, title: project.meta.title, summary, policy }] : [];
  });
}

/** What `writeProjectLocation` wrote: a path, '' (turned off) or null (none: the parent project's is inherited). */
type ProjectLocation = { task: string; cwd: string | null };
/**
 * Sets, turns off ('') or removes (null) a project-type Task's code location on this PC: the only writer of
 * config.yaml's `projects` section. A rerun with the same operation ID replays its receipt.
 */
export async function writeProjectLocation(root: string, taskId: string, cwd: string | null, opId: string): Promise<ProjectLocation> {
  const operation = 'project.location', key = [taskId, cwd];
  const journal = new FileJournal(root);
  const replay = journal.replayConfig<ProjectLocation>(opId, key, operation);
  if (replay) {
    requirePublished(replay);
    return replay.body;
  }
  const task = read(root, db => db.prepare('SELECT kind FROM tasks WHERE external_id = ?').get(taskId));
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  if (task.kind !== 'project') throw new Problem(PROBLEM_CODE.invalidInput, 'Only a project has a code location', { task: taskId }, { reason: { kind: 'only_project_has_code_location' } });
  const location = cwd === null || cwd === '' ? cwd : launchDirectory(root, cwd);
  const writer = new FileWriter(root);
  try { return await writer.locked(async () => {
    journal.assertAvailable(CONFIG_FILE);
    const before = writer.read(CONFIG_FILE);
    const { document, values } = parseConfig(new TextDecoder('utf-8', { fatal: true }).decode(before ?? Buffer.alloc(0)));
    const projects = { ...values.projects };
    if (location === null) delete projects[taskId];
    else projects[taskId] = { cwd: location };
    projectLocationsSchema.parse(projects);
    if (Object.keys(projects).length) document.set('projects', document.createNode(projects));
    else document.delete('projects');
    const outcome = journal.putConfig({ opId, operation, bytes: Buffer.from(document.toString({ lineWidth: 0 })),
      expectedDigest: before === null ? null : digest(before), result: { task: taskId, cwd: location }, fingerprintKey: key });
    requirePublished(outcome);
    return outcome.body;
  }); } finally { writer.close(); }
}

/** The installed app's name: the title of the only active project without a parent, else the product's name. */
export function screenName(root: string): string {
  try {
    const [only, other] = read(root, db => {
      const shelf = projectShelfIn(db);
      return shelf.projects.filter(project => project.meta.parentId === null && shelf.listed.has(project.id));
    });
    return only && !other ? only.meta.title : DEFAULT_PROJECT_NAME;
  } catch { return DEFAULT_PROJECT_NAME; }
}
