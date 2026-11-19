import { installAgentStub } from './agent-stub.ts';
import { ControlStore } from '@alpacawork/db';
import { initialControlDocument, type TaskValues } from '@alpacawork/raw';
import { DEFAULT_FIELDS, DEFAULT_PROJECT_NAME } from '@alpacawork/contract';
import { writeFieldDef } from '@alpacawork/backend/test-dist/control/task-values-store.js';
import type { PlaceAgentReceipt } from '@alpacawork/contract/control';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskTransition } from '@alpacawork/backend/test-dist/control/task-transition.js';
import type { RunStore, RunTransaction } from '@alpacawork/runs';

/** Low-level execution fixtures also seed the admission fence that a real RequestService records. */
export function grantFixtureRequest(store: RunStore, runs: RunTransaction, requestId: string): void {
  const request = runs.getRequest(requestId);
  if (!request) throw new Error('Fixture Request must exist before its grant');
  new TaskTransition().captureStartGrant({ store, runs }, request.taskId, request.id, request.author);
}

/**
 * Seed the current Task/Run store for tests that construct their own workspace: the root project P1, as a new
 * workspace starts, and a project below it for the test's Tasks. Returns that project's ID.
 */
export function initializeControlFixture(root: string): string {
  process.env.PATH = installAgentStub(root, 'claude');
  const store = new ControlStore(root, { busyTimeoutMs: 1_000 }, false, true);
  try {
    return store.write(db => {
      const tasks = new TaskRepository(root, db);
      const project = (parentId: string | null, title: string) => tasks.create('project', id => ({ values: {}, settings: { color: '#39659b' },
        meta: initialControlDocument(id, parentId, title, { kind: 'project', userRequested: false, actor: { kind: 'human' } }) }));
      // Tests report done without writing the fields a done report needs; the required check has its own tests
      // (required-fields), which turn it back on.
      for (const def of DEFAULT_FIELDS) if (def.required) writeFieldDef(db, { ...def, required: false }, new Date().toISOString());
      return project(project(null, DEFAULT_PROJECT_NAME), 'Test project');
    });
  } finally { store.close(); }
}

/**
 * Places a responsible on `task` (its ID and current hash) as a person does with agent assign --role responsible: one
 * write that records the change on the Task, so the Task's hash moves. `profileKey` must be in config.yaml.
 */
export async function assignResponsible(root: string, task: { id: string; hash: string },
  profileKey: string): Promise<PlaceAgentReceipt['placement']> {
  return (await new PlacementCommands(root).placeNewResponsible({ taskId: task.id, profileKey,
    expectedTaskHash: task.hash }, { kind: 'human' })).placement;
}

/** A real repository read at the point a fixture prepares a new, distinct Request. */
export function currentTaskHash(root: string, taskId: string): string {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { return store.read(db => new TaskRepository(root, db).get(taskId).hash); }
  finally { store.close(); }
}
/** The Task's History as stored now; a write's receipt carries none. */
export function currentTaskLog(root: string, taskId: string) {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { return store.read(db => new TaskRepository(root, db).get(taskId).meta.log); }
  finally { store.close(); }
}


/** Seed Task facts without posing as a human creating a child through command authorization. */
export function seedFixtureTask(root: string, parentId: string, title: string, values: TaskValues = {}): { id: string; hash: string } {
  const control = new ControlStore(root, { busyTimeoutMs: 1000 });
  try {
    return control.write(db => {
      const tasks = new TaskRepository(root, db), parent = tasks.get(parentId);
      const id = tasks.create('task', id => ({ values, meta: initialControlDocument(id, parentId, title,
        { kind: 'task', userRequested: parent.meta.kind === 'project', actor: { kind: 'human' } }) }));
      return { id, hash: tasks.get(id).hash };
    });
  } finally { control.close(); }
}
