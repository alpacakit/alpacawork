import { inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
/** Approved sample data only; generated workspaces are never committed. */
import type { RunRecord } from "@alpacawork/contract/run";
import type { TaskValues } from "@alpacawork/contract";
type TaskState = "todo" | "doing" | "waiting" | "done" | "stopped";
type TaskLog = { kind: "created" | "reported"; at: string; title: string | null; description: string | null;
  toState?: TaskState };
type SampleChange = { kind: "new" | "content"; delta: string }
  | { kind: "state"; delta: string; from: TaskState };

/** The fixture's fixed clock. Every time is Japan time on 2026-09-25 or the day before. */
const at = (clock: string, day = "2026-09-25") => `${day}T${clock}:00+09:00`;
export const SAMPLE_NOW = at("14:21");
export const SAMPLE_CHANGED_AT = at("14:12");
export const SAMPLE_CHECKPOINT_AT = at("13:40");

type SampleTask = {
  id: string;
  path: string;
  parent: string | null;
  /** The root is the department, a project; every other sample Task is work in it. */
  kind: "task" | "project";
  title: string;
  state: TaskState;
  /** Whether the person asked for it: the department's top task, and each task that waits for the person's review. */
  userRequested: boolean;
  owner: string;
  children: string[];
  change: SampleChange | null;
  /** Its values by field ID (task_values), as its owner writes them with --values-file. */
  values: TaskValues;
  version: number;
  logs: TaskLog[];
};

const departments: [string, string[], string[]][] = [
  ["Accounting and Finance", ["September monthly close"], ["Invoice reconciliation", "Revenue recognition review", "Expense classification", "Payment difference review", "Accrued expense totals", "Journal entry review", "Monthly report preparation", "Approval workflow organization"]],
];
/** The sample's one project: its department, which holds every other sample Task and names the screen. */
export const SAMPLE_PROJECT = { id: "P1", title: departments[0]![0] };
const agents = ["Astra", "Fable", "Codex", "Nova", "Orion"];
const states: TaskState[] = ["done", "doing", "waiting", "todo", "done", "stopped", "todo", "done"];

/** The sample's single-digit folder segments name a path, while its Task ID is flat. */
export const sampleTaskId = (path: string) => path.includes("/") ? path.replaceAll("/T", "") : path.replace(/^T/, "P");

/** The small shared e2e sample, in insertion order. Large trees belong to e2e/perf. */
export function createSampleTasks(): SampleTask[] {
  const tasks: SampleTask[] = [];
  const byPath = new Map<string, SampleTask>();
  const get = (path: string) => byPath.get(path)!;
  const add = (path: string, parentPath: string | null, title: string, state: TaskState, owner: string) => {
    const n: SampleTask = {
      id: sampleTaskId(path), path, parent: parentPath && sampleTaskId(parentPath), kind: parentPath ? "task" : "project",
      title, state, userRequested: false, owner, children: [], change: null,
      values: { notes: `${title}: organize the scope and steps so the agent can make a decision.` },
      version: 1, logs: [],
    };
    tasks.push(n);
    byPath.set(path, n);
    if (parentPath) get(parentPath).children.push(n.id);
    return n;
  };
  departments.forEach((d, di) => {
    const rid = `T${di + 1}`;
    // A project never works: it has no state of its own and no one placed on it.
    add(rid, null, d[0], "todo", "");
    d[1].forEach((top, pi) => {
      const pid = `${rid}/T${pi + 1}`;
      // Every top task has active descendants. Its initial state already reflects C1.
      add(pid, rid, top, "doing", agents[(pi + di) % 5]!);
      d[2].forEach((title, ti) => {
        const id = `${pid}/T${ti + 1}`;
        const state = states[(ti + pi) % 8]!;
        add(id, pid, title, state, ti === 5 ? "Sato" : agents[(ti + pi + di + 1) % 5]!);
        if (ti === 0 || ti === 3)
          for (let k = 0; k < 2; k++)
            add(`${id}/T${k + 1}`, id, di === 0 && pi === 0 && ti === 3 && k === 1 ? "Exchange difference reconciliation" : k ? "Reconciliation result review" : "Source data preparation",
              k ? "todo" : "done", agents[(k + ti + di + 2) % 5]!);
      });
    });
  });
  const change = (id: string, data: SampleChange, state?: TaskState) => {
    const n = get(id);
    n.change = data;
    if (state) {
      n.state = state;
    }
  };
  change("T1/T1/T1", { kind: "state", delta: "Changed from working to awaiting review", from: "doing" }, "waiting");
  change("T1/T1/T3", { kind: "content", delta: "Updated the description to include overseas expenses" });
  change("T1/T1/T4/T2", { kind: "new", delta: "Newly added" });
  const waitIds = new Set(["T1/T1/T1", "T1/T1/T3"]);
  for (const n of tasks) {
    if (n.state === "waiting" && !waitIds.has(n.path)) n.state = "done";
  }
  // Ordinary user requests live directly below the project. The two waiting children explicitly represent
  // historical marked reviews: those reads are preserved until the user confirms or sends them back.
  const projects = new Set(tasks.filter((n) => n.kind === "project").map((n) => n.id));
  for (const n of tasks) n.userRequested = n.kind === "task" && (projects.has(n.parent!) || n.state === "waiting");
  for (const n of tasks) {
    // A project's own value is its policy, free text written as the user likes.
    n.values = n.kind === "project" ? {
      project_policy: "Goal: close September's books on time with every difference explained.\n\n" +
        "- Reconcile against the source documents before adjusting an entry\n- Ask before posting an adjustment over 100,000 yen\n" +
        "- Do not send anything to vendors without approval",
    } : {
      goal: "Review 100% of the scope",
      conclusion: "Organized the scope and approach.",
      remaining: ["Content review by the agent"],
      conditions: ["Scope preparation — 充足", "Performing the work — 未充足", "Final review — 未確認"],
      ...n.values,
    };
    n.logs = [
      { kind: "created", at: at("09:00", "2026-09-24"), title: null, description: null },
    ];
    if (n.change) n.logs.push({ kind: n.change.kind === "new" ? "created" : "reported", at: SAMPLE_CHANGED_AT,
      title: n.change.kind === "new" ? null : n.change.delta, description: null });
    if (n.state === "waiting") n.logs.push({ kind: "reported", at: n.change ? SAMPLE_CHANGED_AT : at("13:10"),
      title: "Please review", description: null, toState: "waiting" });
  }
  const invoice = get("T1/T1/T1");
  invoice.version = 2;
  invoice.values = {
    goal: "Confirm invoice amounts for 12 synthetic vendors",
    conclusion: "10 synthetic vendors matched. Two need review.",
    remaining: ["Review duplicates for Sample Cedar Supplies and Sample Maple Delivery"],
    conditions: ["Collecting documents from 12 synthetic vendors — 充足", "Invoice amount reconciliation — 充足", "Deciding on two duplicates — 未確認"],
    artifact: ["Reconciliation sheet — September/invoices.xlsx"],
    notes: "Reconciled invoices from 12 synthetic vendors. Please review the two possible duplicates.\n\n## Reconciliation results\n| Scope | Result | Next step |\n| --- | --- | --- |\n| Sample Cedar Supplies | Two invoices for the same amount | Check the original |\n| Sample Maple Delivery | Duplicate invoice number | Check the reissued invoice |\n\n関連タスク: T114\n\n> Update the monthly report after deciding whether they are duplicates.\n\n```text\nItems reviewed: 12\nMatched: 10\nNeeds review: 2\n```",
  };
  const unassigned = get("T1/T1/T7");
  unassigned.owner = "";
  return tasks;
}

/**
 * Ended/review runs are stable under serve's settle loop. R4 still waits for R5.
 * Only normally finished Runs have a result in the database, as in real Runs.
 * Serve applies an owner Run's start and end to its Task unless a later state change of the Task decides instead; each
 * owner Run here is followed by one, so the Tasks keep their sample states (an owner Run that ended unreported after
 * them would err its Task).
 */
export function createSampleRuns() {
  const sample = (id: string, fields: Partial<RunRecord>, prompt: string, result: string | null = null) => ({
    record: {
      id, task: sampleTaskId("T1/T1/T1"), placementId: "Ppending", requestId: `request-${id}`, agent: "codex", role: "worker", resumes: null, continues: false,
      session: { provider: "codex", id: `synthetic-codex-catalog-${id}` }, caller: null,
      cwd: "/tmp/synthetic-catalog", launch: inertFixtureLaunch('codex'),
      state: "succeeded", reason: null, into: null, stop_requested: false,
      usage: null,
      exit: { code: 0, signal: null }, created_at: at("13:00"), started_at: at("13:01"), ended_at: at("13:10"),
      pids: { manager: null, agent: null }, ...fields,
    } satisfies RunRecord,
    prompt, result, stdoutModifiedAt: at("14:10"),
  });
  const owner: Pick<RunRecord, "agent" | "role" | "session" | "launch"> = { agent: "claude", role: "owner", session: { provider: "claude", id: "synthetic-claude-catalog-R1" },
    launch: inertFixtureLaunch('claude', { model: 'claude-opus-5-5' }) };
  const tokens = (input: number, cacheRead: number, cacheWrite: number, output: number) =>
    ({ input, cacheRead, cacheWrite, output });
  return [
    sample("R1", { ...owner, stop_requested: true,
      usage: { conversation: tokens(12000, 31000, 2000, 6000), run: tokens(12000, 31000, 2000, 6000), includesEarlier: false } },
      "Reconcile invoices from 12 synthetic vendors and check for differences and duplicates.",
      "10 synthetic vendors matched. The remaining two require checking the originals."),
    sample("R2", { caller: { run: "R1" }, state: "cancelled", reason: "stopped", exit: { code: null, signal: "SIGTERM" } },
      "Please check the original Sample Cedar Supplies invoice."),
    sample("R3", { caller: { run: "R1" }, usage: { conversation: tokens(4000, 7000, 0, 1000),
      run: tokens(4000, 7000, 0, 1000), includesEarlier: false } },
      "Please reconcile the Sample Maple Delivery invoice number.", "Confirmed a duplicate invoice number. It needs comparison with the reissued invoice."),
    sample("R4", { ...owner, resumes: "R1", created_at: at("13:30"), started_at: at("13:31"), ended_at: at("13:45"),
      usage: { conversation: tokens(18000, 41000, 2000, 8000), run: tokens(6000, 10000, 0, 2000), includesEarlier: false } },
      "Continue reviewing the remaining two vendors and propose updates to the monthly report.", "Requested further checks of the originals. Waiting for the child tasks."),
    sample("R5", { caller: { run: "R4" }, state: "needs_review", reason: "manager_lost", exit: null,
      created_at: at("13:35"), started_at: at("13:36"), ended_at: null },
      "Please compare the Sample Cedar Supplies original and reissued invoices."),
    sample("R6", { resumes: "R3", session: { provider: "codex", id: "synthetic-codex-catalog-R3" }, state: "needs_review", reason: "conversation_busy",
      exit: { code: 1, signal: null }, created_at: at("14:00"), started_at: at("14:01"), ended_at: at("14:02") },
      "Check the Sample Maple Delivery reissued invoice and report any duplicate entries."),
    sample("R7", { ...owner, task: sampleTaskId("T1/T1/T3"), session: { provider: "claude", id: "synthetic-claude-catalog-R7" },
      state: "failed", reason: "exit", exit: { code: 1, signal: null },
      created_at: at("14:05"), started_at: at("14:06"), ended_at: at("14:09") },
      "Classify overseas expenses by account."),
  ];
}
