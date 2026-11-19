/**
 * What a committed write or an outside observation touched, named by the record it touched. The screen's projection
 * maps each key to the Tasks it affects; a writer never decides that mapping.
 */
export const DATABASE_CHANGE_KINDS = ['task', 'log', 'task_value', 'dependency', 'placement', 'wait_cycle', 'request',
  'start_grant', 'stop_epoch', 'run', 'attempt', 'input', 'return', 'delivery', 'resolution', 'dialogue',
  'conversation', 'refusal', 'field_def', 'project_field'] as const;
/** Changes outside the control database, observed by serve itself. */
export const OUTSIDE_CHANGE_KINDS = ['files', 'activity', 'config', 'person'] as const;
export type ChangeKind = typeof DATABASE_CHANGE_KINDS[number] | typeof OUTSIDE_CHANGE_KINDS[number];
/** `id` is the touched record's own key as text (a Task's public ID, a Run's ID, a Request's ID, ...). */
export type ChangeKey = Readonly<{ kind: ChangeKind; id: string }>;
/**
 * A position in the change log (its append number). A different type from the screen's projection version: a position
 * counts appended batches of keys, a projection version counts published frames.
 */
export type ChangeSeq = number & { readonly changeSeq: unique symbol };
