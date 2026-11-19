/** Normal browsing and implicit project selection share this owner. It does not grant writes, choose launchCwd,
 * or stop delivery: explicit IDs and routing keep their existing lifecycle/authorization rules. No derived state is stored. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ControlStore, taskHash } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { TaskLifecycle, TaskState } from '@alpacawork/raw';
import { projectSettingsSchema } from '@alpacawork/raw/project-settings';
import type { ProjectShelfInfo, ProjectShelfDTO } from '@alpacawork/contract/control';
import { TaskTree } from './task-store.js';

type Node = { id: string; settings: { color: string } | null;  meta: { id: string; kind: 'project' | 'task'; parentId: string | null;
  lifecycle: TaskLifecycle; title: string; state: TaskState }; hash: string };
export class ProjectShelf {
  readonly tree: TaskTree<Node>;
  readonly listed: ReadonlySet<string>;
  readonly revision: string;
  constructor(readonly projects: readonly Node[]) {
    this.tree = new TaskTree(projects);
    this.listed = new Set(projects.filter(project => this.of(project.id).listed).map(project => project.id));
    this.revision = createHash('sha256').update(JSON.stringify(projects.map(project =>
      [project.id, project.meta.parentId, project.meta.lifecycle, project.meta.title, project.hash]))).digest('hex');
  }
  of(id: string): ProjectShelfInfo {
    const project = this.tree.byId.get(id);
    if (!project) throw new Problem(PROBLEM_CODE.notFound, 'Project does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
    const shelvedBy = [...this.tree.ancestors(id).reverse(), project].filter(item => item.meta.lifecycle !== 'active')
      .map(item => ({ id: item.id, title: item.meta.title, color: item.settings!.color, lifecycle: item.meta.lifecycle, hash: item.hash }));
    const first = shelvedBy[0];
    return { listed: !first, shelvedBy, restoreTarget: first?.lifecycle === 'archived'
      ? { id: first.id, title: first.title, color: first.color, hash: first.hash } : null };
  }
  catalog(): ProjectShelfDTO {
    return { revision: this.revision, projects: this.projects.filter(project => project.meta.lifecycle !== 'deleted' && !this.listed.has(project.id))
      .map(project => ({ id: project.id, title: project.meta.title, color: project.settings!.color, parentId: project.meta.parentId,
        lifecycle: project.meta.lifecycle, hash: project.hash, shelf: this.of(project.id) })) };
  }
}
export function projectShelfIn(db: DatabaseSync): ProjectShelf {
  return new ProjectShelf(db.prepare(`SELECT t.id,t.external_id,t.title,t.lifecycle,t.state,t.revision,t.settings,parent.external_id AS parent_id
    FROM tasks t LEFT JOIN tasks parent ON parent.id=t.parent_id WHERE t.kind='project' ORDER BY t.number`).all().map(row => ({
      id: String(row.external_id), settings: projectSettingsSchema.parse(JSON.parse(String(row.settings))), hash: taskHash(String(row.id), Number(row.revision)),
      meta: { id: String(row.external_id), kind: 'project', state: String(row.state) as TaskState, title: String(row.title), parentId: row.parent_id === null ? null : String(row.parent_id),
        lifecycle: String(row.lifecycle) as Node['meta']['lifecycle'] } })));
}
export function readProjectShelf(root: string): ProjectShelf {
  const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { return control.read(projectShelfIn); } finally { control.close(); }
}
/** Project shelving, rather than this Task's own individual lifecycle. */
export function taskShelfIn(db: DatabaseSync, id: string): ProjectShelfInfo {
  const task = db.prepare(`SELECT ifnull(p.external_id,t.external_id) AS project FROM tasks t
    LEFT JOIN tasks p ON p.id=t.project_task_id WHERE t.external_id=?`).get(id);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
  return projectShelfIn(db).of(String(task.project));
}
