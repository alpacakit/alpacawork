import { compareHistoryEvents, type HistoryEventKind } from './history-events.js';

/** Only the facts layout consumes. Caller-specific text/marks stay on the caller's immutable record. */
export type LayoutRecord = {
  key: string; at: string; id: string; taskId: string; kind: HistoryEventKind;
  text: string; description: string | null; mark: object | null;
  author?: { kind: string }; recipient?: { role: string };
  sourceTaskId?: string; userQuestion?: boolean; pinned?: boolean; finish?: boolean;
  answers?: string; message?: string; wordsKey?: string; wroteIn?: string; consumedBy?: string[];
  runId?: string; changed?: string;
};

export type ReportTier = "story" | "line" | "inner";
/** A Derived display tree. Original records remain separate and can always be addressed by their keys. */
export type DisplayNode<Record extends LayoutRecord> = { report: Record; tier: ReportTier; chain: DisplayNode<Record>[]; inner: DisplayNode<Record>[];
  relayed: DisplayNode<Record>[]; earlier: DisplayNode<Record>[]; answer?: DisplayNode<Record>; via?: DisplayNode<Record> };
export type DisplayRow<Record extends LayoutRecord> = { kind: "one"; key: string; node: DisplayNode<Record> } | { kind: "inner"; key: string; items: DisplayNode<Record>[] };
export type ReportLayout<Record extends LayoutRecord> = { rows: DisplayRow<Record>[]; targets: Map<string, string> };

/**
 * The sole row/fold rule for History and the list's time line. A responsible Run, not a time window, is one unit.
 * Questions/reviews/finishes/urgent reports and the last own report are actions; earlier notes go under the next
 * action of that Run. A child's delivered record goes under the first visible consuming Run's last action.
 * Unlinked records and human decisions remain visible. Pairing uses record references, with equal dialogue words
 * merged only inside the approved ten-minute window. No input record is mutated.
 */
export function reportDisplay<Record extends LayoutRecord>(reports: readonly Record[]): ReportLayout<Record> {
  const tier = (report: Record): ReportTier => {
    if (report.kind === "run_end") return "line";
    if (report.userQuestion) return "story";
    if (report.sourceTaskId) return report.mark ? "story" : "line";
    if (report.author?.kind === "member" || report.kind === "request" && report.recipient?.role === "member"
      || report.kind === "error" && !report.runId) return "inner";
    return report.mark ? "story" : "line";
  };
  const ordered = [...reports].sort(compareHistoryEvents);
  const nodes = ordered.map((report): DisplayNode<Record> => ({ report, tier: tier(report), chain: [], inner: [], relayed: [], earlier: [] }));
  const byId = new Map<string, DisplayNode<Record>>();
  const dialogues = new Map<string, DisplayNode<Record>>();
  for (const node of nodes) {
    byId.set(`${node.report.taskId}:${node.report.id}`, node);
    if (node.report.kind === "dialogue") dialogues.set(node.report.id, node);
  }
  const parent = new Map<string, DisplayNode<Record>>();
  const attach = (child: DisplayNode<Record>, into: DisplayNode<Record>, group: "chain" | "inner" | "relayed" | "earlier") => {
    into[group].push(child); parent.set(child.report.key, into);
  };
  for (const node of nodes) {
    const { report } = node;
    const question = report.answers ? byId.get(`${report.taskId}:${report.answers}`) : undefined;
    if (report.kind === "answer" && question?.report.kind === "question" && !question.answer) {
      question.answer = node; parent.set(report.key, question);
      const via = report.message ? dialogues.get(report.message) : undefined;
      if (via) { node.via = via; parent.set(via.report.key, node); }
    }
  }
  for (const node of nodes) {
    if (node.report.kind !== "request" || !node.report.message) continue;
    const dialogue = dialogues.get(node.report.message);
    if (dialogue) attach(node, dialogue, "relayed");
  }
  const twins = new Map<string, DisplayNode<Record>[]>();
  for (const node of nodes) {
    if (node.report.kind !== "dialogue" || !node.report.wordsKey || parent.has(node.report.key)) continue;
    const key = `${node.report.taskId}:${node.report.wordsKey}`;
    const seen = twins.get(key) ?? [];
    const twin = seen.find(each => Date.parse(each.report.at) - Date.parse(node.report.at) < 10 * 60_000);
    if (twin) attach(node, twin, "earlier");
    else { seen.push(node); twins.set(key, seen); }
  }
  const runs = new Map<string, DisplayNode<Record>[]>();
  for (const node of nodes) {
    const report = node.report;
    if (parent.has(report.key) || report.sourceTaskId || !report.wroteIn || node.tier !== "story"
      || report.author?.kind !== "owner") continue;
    const records = runs.get(report.wroteIn) ?? [];
    records.push(node); runs.set(report.wroteIn, records);
  }
  const newestAction = new Map<string, DisplayNode<Record>>();
  const actionKinds = new Set(["question", "review", "report", "urgent"]);
  for (const [run, records] of runs) {
    const newest = records[0]!;
    newestAction.set(run, newest);
    const actions = records.filter(node => node === newest || actionKinds.has(node.report.kind) || node.report.pinned);
    for (const step of records) {
      if (actions.includes(step)) continue;
      // Nearest following action, not the last action of a later Run.
      const next = [...actions].reverse().find(action => action.report.at >= step.report.at) ?? newest;
      attach(step, next, "chain");
    }
  }
  for (const node of nodes) {
    const report = node.report;
    if (parent.has(report.key) || !report.sourceTaskId || report.userQuestion || report.kind === "urgent" || report.kind === "run_end") continue;
    const run = report.consumedBy?.find(run => newestAction.has(run));
    if (run) attach(node, newestAction.get(run)!, "chain");
  }
  for (const node of nodes) node.chain.sort((a, b) => a.report.at.localeCompare(b.report.at) || a.report.key.localeCompare(b.report.key));
  const rows: DisplayRow<Record>[] = [];
  for (const node of nodes) {
    if (parent.has(node.report.key) || displayKind(node.report) === "record") continue;
    const last = rows.at(-1);
    if (node.tier !== "inner" || node.report.userQuestion) rows.push({ kind: "one", key: node.report.key, node });
    else if (last?.kind === "one" && last.node.tier === "story" && !last.node.report.sourceTaskId)
      attach(node, last.node, "inner");
    else if (last?.kind === "inner") last.items.push(node);
    else rows.push({ kind: "inner", key: `inner:${node.report.key}`, items: [node] });
  }
  // A one-item work fold would disclose the same row twice.
  const singles = rows.map((row): DisplayRow<Record> => row.kind === "inner" && row.items.length === 1
    ? { kind: "one", key: row.items[0]!.report.key, node: row.items[0]! } : row);
  const targets = new Map<string, string>();
  const index = (node: DisplayNode<Record>, row: string) => {
    targets.set(node.report.key, row);
    for (const child of reportChildren(node)) index(child, row);
  };
  for (const row of singles) for (const node of row.kind === "one" ? [row.node] : row.items) index(node, row.key);
  return { rows: singles, targets };
}

/** Traversal only; all grouping decisions belong to reportDisplay. */
export const reportChildren = <Record extends LayoutRecord>(node: DisplayNode<Record>): DisplayNode<Record>[] => [
  ...(node.answer ? [node.answer] : []), ...(node.via ? [node.via] : []), ...node.relayed, ...node.earlier, ...node.chain, ...node.inner,
];
export const reportContains = <Record extends LayoutRecord>(node: DisplayNode<Record>, key: string | null): boolean => !!key &&
  (node.report.key === key || reportChildren(node).some(child => reportContains(child, key)));

/** Kinds a row is named by, so it says something without words of its own. */
const LABELLED: ReadonlySet<HistoryEventKind> = new Set(["request", "answer", "error", "run_end", "dialogue", "conversation"]);
/**
 * Kinds that only close a wait. The wait's own card says how it closed (its released mark), so a row of their own
 * would tell it twice, beside whatever newer record closed it.
 */
const CLOSES_A_WAIT: ReadonlySet<HistoryEventKind> = new Set(["withdrawn", "expired"]);
/** How the column lays a report out (reportDisplay): a card, a row, or nothing when it has nothing to say. */
export const displayKind = (report: Pick<LayoutRecord, "kind" | "mark" | "changed" | "finish" | "text" | "description">): "report" | "line" | "record" =>
  report.mark ? "report" : CLOSES_A_WAIT.has(report.kind) ? "record"
    : LABELLED.has(report.kind) || report.changed || report.finish || report.text || report.description ? "line" : "record";
