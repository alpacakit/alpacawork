/**
 * The incremental projection's types: the records serve keeps of the control database (WorkspaceRecords), the one way
 * derivations read them (RecordsReader), what a change affects (affected), each Task's derived values (deriveTask), the
 * aggregates kept by difference (aggregate), the frame published at once (PublishedFrame) and the work handed to return
 * routing. Which input reaches which Task is the dependency ledger's; the reverse indexes below are the ones it names.
 * Nothing here is wired yet: the implementations replace the per-project tree reads piece by piece.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeKey, ChangeSeq } from '@alpacawork/db';
export type { ChangeSeq } from '@alpacawork/db';
import type { ControlTask } from '@alpacawork/raw';
import type { Ball, FieldCatalog, ReadRunRecord, RunId, RunResultState, UsageTotal, RunActivity } from '@alpacawork/contract';
import type { ControlIndexDTO, ControlRunDTO, ControlTreeDTO, IndexPatchDTO, PlacementDTO, ProjectionVersion,
  RequiredPvDTO, TaskViewRowDTO } from '@alpacawork/contract/control';
import type { RunSnapshot, StoredPlacement, StoredRequest, StoredReturn } from '@alpacawork/runs';
import type { ProjectShelf } from '../control/project-shelf.js';
import type { seatSettings } from '../control/wake.js';

/** A Task's public ID (T42, P3). */
export type TaskId = string;
/** The kinds of key a committed database write names (the rest are serve's own observations). */
export type DatabaseChangeKind = Exclude<ChangeKey['kind'], 'files' | 'activity' | 'config' | 'person'>;

/**
 * What a change can make old, by surface: a Task's row in the list, its opened view, its History window, its files, its
 * membership in the home list, pages and counts, a closed page's rows and order, search, the timeline, return routing's
 * seat facts, and push's holding keys.
 */
export const FACETS = ['row', 'view', 'history', 'files', 'membership', 'page', 'search', 'timeline', 'seat', 'push'] as const;
export type Facet = typeof FACETS[number];

/** Optional folder facts captured by the records layer, never reread during derivation. */
export interface RunFileRecord {
  readonly activity: RunActivity | null;
  readonly errorCause: ControlRunDTO['errorCause'] | undefined;
}

/** One Task's records as serve holds them: what the derivations read of it, and nothing of other Tasks. */
export interface TaskBundle {
  readonly task: ControlTask;
  readonly placements: readonly StoredPlacement[];
  /** Its own Runs, every role. */
  readonly runs: readonly ReadRunRecord[];
  /** Present on database-backed bundles; kept optional for the other chunks' existing fake readers. */
  readonly runFiles?: ReadonlyMap<RunId, RunFileRecord>;
  readonly resultStates: ReadonlyMap<RunId, RunResultState>;
  /** By its placement, the newest Run of the placement's conversation that is neither joined nor aborted, every role. */
  readonly headRunIds: ReadonlyMap<string, RunId | null>;
  /** The Requests it received. */
  readonly requests: readonly StoredRequest[];
  /** Sent candidates without a permanent close, with mutable rows captured at this frame. */
  readonly unclosedSent?: readonly StoredRequest[];
  readonly returnCauseTasks?: ReadonlyMap<string, string>;
  /** The returns addressed to it, with their deliveries and resolution. */
  readonly returns: readonly StoredReturn[];
  readonly waitCycles: readonly RunSnapshot['waitCycles'][number][];
  /** Its Runs' inputs: by placement, the fed Runs whose receipt is uncertain; the Runs whose input closed. */
  readonly inputs: { readonly uncertain: ReadonlyMap<string, ReadonlySet<RunId>>; readonly closed: ReadonlySet<RunId> };
  /** The Tasks it starts after (its own dependency edges). */
  readonly after: readonly TaskId[];
  readonly dialogues: readonly ControlTreeDTO['dialogues'][number][];
  /** The fixed texts of the answers in its log, by log ID. */
  readonly answerTexts: Readonly<Record<string, string>>;
  readonly requestedByUser: ControlTreeDTO['requestedByUser'][string] | null;
  readonly files: ControlTreeDTO['tasks'][number]['files'];
}
/** What a coordinator Run that took a screen message shows of it (History's coordinator end). */
export type CoordinatorRunFact = ControlTreeDTO['historyFacts']['coordinatorRuns'][string];

/**
 * The only way `deriveTask`, `affected`, `aggregate` and the view, History, page, search and timeline reads read the
 * records. A test substitutes an implementation that records what was read, and checks each read against `affected`.
 */
export interface RecordsReader {
  /** The projection version of the frame these records belong to. */
  readonly pv: ProjectionVersion;
  taskIds(): Iterable<TaskId>;
  bundle(task: TaskId): TaskBundle | undefined;
  run(run: RunId): ReadRunRecord | undefined;

  // The tree.
  parent(task: TaskId): TaskId | null;
  children(task: TaskId): readonly TaskId[];
  /** Nearest first, up to the top project. */
  ancestors(task: TaskId): readonly TaskId[];
  subtree(task: TaskId): Iterable<TaskId>;
  /** Its nearest project (a project Task's own is itself). */
  projectOf(task: TaskId): TaskId;
  /** The listed scopes it is counted and listed in: `root` and each listed project whose subtree holds it, top first. */
  scopes(task: TaskId): readonly string[];

  // The owners of records.
  logOwner(log: string): TaskId | undefined;
  runOwner(run: RunId): TaskId | null;
  requestOwner(request: string): TaskId | null;
  placementOwner(placement: string): TaskId | undefined;
  returnOwner(returnId: string): TaskId | undefined;

  // The reverse indexes of the dependency ledger (§3).
  /** The Tasks that start after `task`. */
  dependents(task: TaskId): readonly TaskId[];
  runByRequest(request: string): RunId | undefined;
  /** The Runs whose caller, resumes or into names `run`. */
  runReferrers(run: RunId): readonly RunId[];
  /** The Tasks that sent `task` a Request with no closing return yet, continuations aside. */
  sendersTo(task: TaskId): readonly TaskId[];
  /** The Tasks `task` ever sent a Request to, closed ones included. */
  targetsFromAll(task: TaskId): readonly TaskId[];
  /** Requests sent by this seat, including closed ones; the Request rules decide which still wait for a return. */
  sentRequests(task: TaskId): readonly StoredRequest[];
  /** Whether a closing return exists for the Request. */
  closedRequest(request: string): boolean;
  /** The Tasks a return caused by one of `task`'s log entries is addressed to. */
  returnsByCauseTask(task: TaskId): readonly TaskId[];
  /** The returns a wake Request delivered. */
  deliveriesByWakeRequest(request: string): readonly string[];
  /** The Tasks with a question addressed to `task`. */
  questionsByDestination(task: TaskId): readonly TaskId[];
  /** The Tasks a coordinator Request (a screen message) is linked to by a dialogue. */
  dialogueTasks(request: string): readonly TaskId[];
  /** The coordinator Requests (messages) whose Runs joined into `run`. */
  joinedMessages(run: RunId): readonly string[];
  /** The Tasks whose log, Requests or dialogues name the screen message. */
  messageTasks(message: string): readonly TaskId[];
  /** The other Tasks holding records written by the placement. */
  placementWritesTo(placement: string): readonly TaskId[];
  /** The Tasks whose History events name `task` (as a parent author, a dependency, a question's destination or a cause). */
  historyReferrers(task: TaskId): readonly TaskId[];
  /** The projects that take their schema from `project`. */
  schemaUsers(project: TaskId): readonly TaskId[];
  /** The projects whose schema uses the field definition. */
  fieldUsers(field: string): readonly TaskId[];

  // Facts that belong to no Task.
  coordinatorRun(message: string): CoordinatorRunFact | undefined;
  catalog(): FieldCatalog;
  /** The schema a project's Tasks use and the project it comes from (null for the default). */
  schemaOf(project: TaskId): ControlTreeDTO['projectSchemas'][string];
  seatSettings(): ReturnType<typeof seatSettings>;
  shelf(): ProjectShelf;
  environment(): Pick<ControlTreeDTO, 'root' | 'profiles' | 'attachmentBytes' | 'errors' | 'writable'>;
}

/** The records after a batch of keys, beside the ones before: both read through the same interface. */
export interface RecordsChange {
  readonly keys: readonly ChangeKey[];
  readonly before: RecordsReader;
  readonly after: RecordsReader;
  /**
   * The owners each key had before and after (a moved or deleted record keeps its old owner here). A coordinator's
   * Request or Run has no owner of its own: the Tasks whose records name its message (dialogues, records and Requests
   * written from it) are its owners here.
   */
  readonly owners: ReadonlySet<TaskId>;
}
/**
 * The records serve keeps. `load` reads everything in one read transaction (startup, resynchronization); `advance`
 * reads again only what the keys name, in one read transaction, and returns the next records without changing these:
 * the frame that holds these keeps reading them until the next one is published.
 */
export interface WorkspaceRecords extends RecordsReader {
  load(db: DatabaseSync, pv: ProjectionVersion): WorkspaceRecords;
  advance(db: DatabaseSync, keys: readonly ChangeKey[], pv: ProjectionVersion): RecordsChange & { readonly next: WorkspaceRecords };
}
export function emptyWorkspaceRecords(): WorkspaceRecords {
  throw new Error('WorkspaceRecords is not implemented yet');
}

/** Who a record named by a key belongs to, read from the database when the records do not hold it yet. */
export type KeyOwner = { readonly task: TaskId | null; readonly coordinator: string | null };
/** For each kind a database write names, how to find the owners of its keys inside a read transaction. */
export type OwnerLookup = { readonly [Kind in DatabaseChangeKind]: (db: DatabaseSync, ids: readonly string[]) => ReadonlyMap<string, KeyOwner> };

/** What a batch of changes makes old: each Task's surfaces, the scopes whose resources changed, and the index's small fields. */
export interface AffectedSet {
  readonly tasks: ReadonlyMap<TaskId, ReadonlySet<Facet>>;
  readonly scopes: { readonly page: ReadonlySet<string>; readonly search: ReadonlySet<string>; readonly timeline: ReadonlySet<string> };
  /** The index's small fields (projects, profiles, errors, person) need making again. */
  readonly meta: boolean;
}

/**
 * A Task's part of the aggregates: what its parent chain, its scopes and the home list read of it. Its own values only;
 * what its descendants add is the aggregate's.
 */
export interface AggregateContribution {
  readonly id: TaskId;
  readonly parentId: TaskId | null;
  readonly projectId: TaskId;
  readonly kind: ControlTask['meta']['kind'];
  readonly lifecycle: ControlTask['meta']['lifecycle'];
  readonly state: ControlTask['meta']['state'];
  readonly baseState: ControlTask['meta']['baseState'];
  readonly hold: ControlTask['meta']['hold'];
  readonly ball: Ball | null;
  /** An active placement with a running Run (runningBelow, childrenRunning). */
  readonly running: boolean;
  /** An active placement with a running or queued Run (workingBelow). */
  readonly working: boolean;
  /** A queued, running or needs-review Run (the home list's working). */
  readonly homeWorking: boolean;
  /** Its ended Runs' usage, known and unknown Runs counted. */
  readonly usage: UsageTotal;
  /** Its running, open Runs with their start, by Run number. */
  readonly openRuns: readonly (readonly [RunId, number])[];
  /** Its own latest move: its newest log entry or Run start or end (movedAt before its descendants). */
  readonly movedAt: number;
}
/** The aggregates as of a frame, read by Task and by scope. */
export interface ScreenAggregate {
  children(task: TaskId): ControlIndexDTO['counts']['children'][string] | undefined;
  movedAt(task: TaskId): number;
  usageBelow(task: TaskId): UsageTotal;
  runsBelow(task: TaskId): readonly (readonly [RunId, number])[];
  /** Running Runs on the Task and on every logical descendant. */
  runningRuns(task: TaskId): number;
  workingBelow(task: TaskId): number;
  live(task: TaskId): boolean;
  home(task: TaskId): ControlIndexDTO['home'][number] | undefined;
  /** The home row the Task's row follows in the list's order (null for the first); undefined when it lists none. */
  homeAfter(task: TaskId): TaskId | null | undefined;
  /** A closed page's rows in order, by its scope name (closedPageScope). */
  page(scope: string): readonly TaskId[];
  counts(): Omit<ControlIndexDTO['counts'], 'children'>;
}
/** What changed in the aggregates, key by key, for the patch and for the Tasks whose rows read them. */
export interface AggregateChanges {
  readonly tasks: ReadonlySet<TaskId>;
  readonly pages: ReadonlySet<string>;
  readonly counts: boolean;
}
/** Takes each changed contribution out of the aggregates and puts its new one in; up the chain only while a value changes. */
export type AggregateUpdate = (previous: ScreenAggregate,
  changes: ReadonlyMap<TaskId, { readonly before: AggregateContribution | undefined; readonly after: AggregateContribution | undefined }>)
  => { readonly next: ScreenAggregate; readonly changed: AggregateChanges };

/** Everything one Task's own records decide (no aggregate), made again only when `affected` names one of its facets. */
export interface TaskDerived {
  readonly id: TaskId;
  /** Its row without what descendants decide: the view's row, and the list row before the aggregates are added. */
  readonly row: TaskViewRowDTO;
  readonly ball: Ball | null;
  /** Every placement and Run of the Task as the screen shows them. */
  readonly placements: readonly PlacementDTO[];
  readonly runs: readonly ControlRunDTO[];
  /** The placements and Runs the live index carries of it while it is live (computed whether or not it is). */
  readonly live: { readonly placements: ReadonlySet<string>; readonly runs: ReadonlySet<RunId> };
  readonly contribution: AggregateContribution;
  /** Push's holding keys of the Task. */
  readonly pushKeys: readonly string[];
}
export type DeriveTask = (records: RecordsReader, task: TaskId) => TaskDerived;

/**
 * One published projection, swapped in at once: readers (opened Tasks, routing, SSE) see one frame whole. `applied` is
 * the change log position its records reach; `requiredPv` is every resource's version as of it.
 */
export interface PublishedFrame {
  readonly generation: string;
  readonly pv: ProjectionVersion;
  readonly applied: ChangeSeq;
  readonly records: RecordsReader;
  derived(task: TaskId): TaskDerived | undefined;
  readonly aggregate: ScreenAggregate;
  readonly requiredPv: RequiredPvDTO;
  /** What this frame changed from the previous one; null for the first frame of a generation or a resynchronization. */
  readonly patch: IndexPatchDTO | null;
}

/**
 * The Tasks return routing goes over, made by a catch-up from the same change as the frame it published: the seat
 * facet's Tasks of the change log's range (after, through]. `sweep` is one slice of the periodic pass over every Task.
 */
export interface RoutingWorkSet {
  readonly after: ChangeSeq;
  readonly through: ChangeSeq;
  readonly tasks: ReadonlySet<TaskId>;
  readonly mode: 'changed' | 'sweep';
}
