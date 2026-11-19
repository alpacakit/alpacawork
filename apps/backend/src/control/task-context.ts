/**
 * What a Task's values say, read for a launch, a question and the screen: the fields its schema uses, its values, and
 * `context`, those values as contract renderContext writes them. A launch's policy chain, its own and parent Task, its
 * children's conclusions, the user's instructions, a question's full text and the screen's context tab all read here,
 * so the text an agent is given and the text a person sees are the same.
 */
import type { DatabaseSync } from 'node:sqlite';
import { fieldCatalog, renderContext, type FieldCatalog, type FieldValue, type TaskValues } from '@alpacawork/contract';
import type { TaskKind } from '@alpacawork/raw';
import type { BranchTask } from '@alpacawork/contract/branch';
import { readProjectSchemas, readStoredFields, readTaskValues, schemaFor, type EffectiveSchema } from './task-values-store.js';
import type { TaskTree } from './task-store.js';

type ContextTree = TaskTree<{ id: string; meta: BranchTask & { kind: TaskKind } }>;
/** The stored facts a context is made of: the workspace's fields, each project's own schema and each Task's values. */
export type ContextFacts = { catalog: FieldCatalog; schemas: ReadonlyMap<string, readonly string[]>;
  values: ReadonlyMap<string, TaskValues> };
export type TaskContexts = {
  readonly catalog: FieldCatalog;
  /** The fields `taskId` uses and the project they come from (null: the default schema). */
  schemaOf(taskId: string): EffectiveSchema;
  /** Every value `taskId` has, those of fields its schema leaves out among them. */
  valuesOf(taskId: string): TaskValues;
  /** One field's value, or undefined when the Task has none. A system field is in every schema, so it is always shown. */
  value(taskId: string, field: string): FieldValue | undefined;
  /** The Task's values in its schema's order as one text (contract renderContext); '' when it has none. */
  context(taskId: string): string;
};

/** The contexts of the Tasks in `tree`, from facts already read (a write checks a change with its own values here). */
export function taskContexts(tree: ContextTree, facts: ContextFacts): TaskContexts {
  const schemaOf = (taskId: string) => schemaFor(tree, facts.schemas, taskId);
  const valuesOf = (taskId: string) => facts.values.get(taskId) ?? {};
  return { catalog: facts.catalog, schemaOf, valuesOf,
    value: (taskId, field) => valuesOf(taskId)[field],
    context: taskId => renderContext(schemaOf(taskId).fields, valuesOf(taskId), facts.catalog) };
}
/** The stored facts of the Tasks in `tree` (all of the workspace's fields and project schemas), in the caller's read. */
export function readContextFacts(db: DatabaseSync, tree: ContextTree): ContextFacts {
  return { catalog: fieldCatalog(readStoredFields(db)), schemas: readProjectSchemas(db),
    values: readTaskValues(db, tree.tasks.map(task => task.id)) };
}
/** The contexts of a tree read with its values (a ControlSnapshot's Tasks and fields), as a write holds them. */
export function snapshotContexts<T extends { id: string; meta: BranchTask & { kind: TaskKind }; values: TaskValues }>(tree: TaskTree<T>,
  fields: Pick<ContextFacts, 'catalog' | 'schemas'>): TaskContexts {
  return taskContexts(tree, { ...fields, values: new Map(tree.tasks.map(task => [task.id, task.values])) });
}
export const readTaskContexts = (db: DatabaseSync, tree: ContextTree): TaskContexts => taskContexts(tree, readContextFacts(db, tree));
