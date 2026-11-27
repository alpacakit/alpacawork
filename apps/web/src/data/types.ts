import type { WriteBasis } from './connection';
import type { ProjectedIndexDTO, ControlReplyDTO, ControlRunDTO, ControlTaskDTO, RequestHeadDTO, StateLogEntryDTO, TaskProjectedViewDTO } from "@alpacawork/contract/control";

/** The contract's TASK_STATE is the only list of task states; the screen shows them in its order. */
export type TaskState = ControlTaskDTO["state"];

/** A task's log entry as the control tree has it, with its writer (`actor`); `detail` is shown as written. */
type TaskLog = ControlTaskDTO["log"][number];

/**
 * What changed since the reader's baseline. The screen words it in the
 * reader's language; only `note` carries text written by the source.
 */
export type ChangeDetail =
  | { type: "created" }
  | { type: "state"; from: TaskState; to: TaskState }
  | { type: "body" }
  | { type: "note"; text: string };

export type TaskChange = {
  /** new: added. state: its state changed. content: anything else. */
  kind: "new" | "state" | "content" | "turn";
  at: string;
  detail: ChangeDetail;
};

/** A task as the index has it: what the tree, the cards, the time view and the notices read. */
export type Task = {
  id: string;
  /** Its parent in the list's tree: null for a task right below its project (the list shows no project rows). */
  parent: string | null;
  /** A project Task holds its settings and the Tasks below it; a task is work. */
  kind: ControlTaskDTO["kind"];
  /** The project Task it belongs to, as its row names it (a project Task's own row names itself). */
  projectId: string;
  title: string;
  state: TaskState;
  baseState: ControlTaskDTO["baseState"]; hold: boolean; allowedActions: ControlTaskDTO["allowedActions"]; policyVersion: string;
  /** Present only on a home row, never on a detail or branch Task. */
  homeRow?: ProjectedIndexDTO["home"][number];
  /** Whose move it waits on, as the server derives it; null when nobody's. */
  ball: ProjectedIndexDTO["tasks"][number]["ball"];
  rowFacts: ProjectedIndexDTO["tasks"][number]["rowFacts"];
  /** The tasks it starts after, as they are now; null when none (a closed page's row may leave it out). */
  startOrder?: ProjectedIndexDTO["tasks"][number]["startOrder"];
  hash: string;
  version: number;
  /** Where the task file is stored, relative to the workspace root. */
  path: string;
  /** The title of its oldest open question; "" when it asks nothing. */
  question: string;
  /** The log entries the index keeps: state changes, estimates, reports, review decisions, questions and instructions. */
  stateLog: StateLogEntryDTO[];
  usage?: ProjectedIndexDTO["tasks"][number]["usage"];
  usageBelow?: ProjectedIndexDTO["tasks"][number]["usageBelow"];
  runsBelow?: ProjectedIndexDTO["tasks"][number]["runsBelow"];
  change: TaskChange | null;
  /** When the task last changed, for notification rows. */
  updatedAt: string;
  createdAt?: string | null;
  movedAt: number;
  /** The automation that created it itself, as it was named then; absent for one a person or an agent created. */
  madeBy?: ProjectedIndexDTO["tasks"][number]["madeBy"];
};

/** An opened task: the row with what `GET /api/task/view` adds. */
export type TaskDetail = Task & {
  /** Responsible placement revision from the same detail snapshot as hash; null is known absence. */
  responsibleRevision: number | null;
  /** Its values, the fields its schema uses, and the context they render as (what its launches carry). */
  values: TaskProjectedViewDTO["values"];
  /** A project's own settings (its colour) as the same snapshot read them. */
  settings?: ControlTaskDTO["settings"];
  logs: TaskLog[];
  files: NonNullable<ControlTaskDTO["files"]>;
  requestHeads: RequestHeadDTO[];
  /** Status and Run ID of the latest final owner reply; History loads its text on opening. */
  reply: ControlReplyDTO | undefined;
  /** Its questions, oldest first, each with what it asks as fixed when it was asked. */
  questions: TaskProjectedViewDTO["questions"];
  /** Human questions shown on this project-direct Task, retaining their original Task and question IDs. */
  userQuestions: TaskProjectedViewDTO["userQuestions"];
  /** Human reviews shown here, retaining the original submission and Task IDs. */
  userReviews: TaskProjectedViewDTO["userReviews"];
  /** When the user asked for it; null when the user did not. */
  requestedByUser: TaskProjectedViewDTO["requestedByUser"];
  /** How often its agents started a conversation anew and compacted one; null until the Task's view is read. */
  conversations: TaskProjectedViewDTO["conversations"] | null;
};

/** Facts about the workspace itself (diagnostics, the server settings, run confirmations). */
export type WorkspaceInfo = {
  root: string;
  rev: number;
  writable: boolean;
  errors: ProjectedIndexDTO["errors"];
  /** Tasks kept from an earlier snapshot because the latest one could not read them. */
  staleIds: string[];
  runs: ControlRunDTO[];
  /**
   * Each child list's numbers, each closed page's version, the top level's closed Tasks per scope (`closed`), how many
   * rows the home list has per scope and section (`home`) and every project's menu numbers (`all`).
   */
  counts: ProjectedIndexDTO["counts"];
  /** The home list's rows as the server projects them (index-feed's homeRows), one per Task it lists, in its order. */
  home: ProjectedIndexDTO["home"];
  /** Launch profiles a person can choose when deciding who is responsible. */
  profiles: ProjectedIndexDTO["profiles"];
  /**
   * The active project Tasks, each with its parent and depth and its tree's numbers (the person's turns, the Tasks
   * running): what the screen shows and narrows to.
   */
  projects: ProjectedIndexDTO["projects"];
  /** limits.attachment_mib in bytes. */
  attachmentBytes: number;
  presence: ProjectedIndexDTO["presence"];
  coordinatorWork: ProjectedIndexDTO['coordinatorWork'];
  /** Set while this machine is tight (the banner and Settings > Resources). */
  host: ProjectedIndexDTO["host"];
  /** The reader's last check; the unread baseline starts here. */
  checkpointAt: string;
  /** Moves whenever an automation or one of its runs is written: the automation reads are keyed by it. */
  automationsVersion: string;
};

