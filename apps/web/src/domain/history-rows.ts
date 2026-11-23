import { OTHER_WORD } from '@alpacawork/contract';
import { recordedAgent, type EndAgent } from './end-agent';
import { reportFlow, type Flow, type FlowEnd, type OpenTask, type Party, type TaskLookup } from './flow';
import { displayKind, reportTone, type Released, type ReportEvent } from './report-events';
import { firstReportLine } from './report-labels';

/** Who a row names, in the words of the open Task: one of its six parties, or a member of the open Task by its agent. */
export type NameEnd = { party: Party | 'member'; taskId?: string; title?: string; agent?: string };
/**
 * `own`: a record of that end alone. Otherwise the two ends a record was between, as every row draws them: the one it
 * came from on the left, the one it went to on the right, with the arrow between them pointing right.
 */
export type RowName = { own: NameEnd } | { ends: readonly [NameEnd, NameEnd] };
/**
 * The rail's mark: up when a record went to someone above whom it came from (a report, a question, a member's result),
 * down when it went to someone under them (a request, an answer), and neither between two that are not one above the other.
 */
export type RowWay = 'up' | 'down' | 'by';
/**
 * How a question or a review ended, or that it still waits: `closed` when no later record says more than the closure,
 * and `again`, `replaced` or `resumed` when the next record of that Task says why it closed.
 */
export type RowOutcome =
  | { kind: 'answered' | 'confirmed'; who: NameEnd['party']; at: string }
  | { kind: 'waiting'; on: NameEnd['party']; review: boolean }
  | { kind: 'again' | 'replaced' | 'resumed'; question: boolean }
  | { kind: 'closed'; why: Released };
/**
 * One row. `older`: the records right below it with the same words and the same body, newest first, which it stands for.
 * `sameTitle`: the row above has the same words over a different body, so what this one says is that they differ.
 */
export type HistoryRow = { key: string; report: ReportEvent; flow: Flow; name: RowName; way: RowWay;
  older: readonly ReportEvent[]; sameTitle: boolean; outcome: RowOutcome | null; asks?: string };

type Said = { report: ReportEvent; flow: Flow };

const sameEnd = (a: FlowEnd, b: FlowEnd) => a.party === b.party && a.taskId === b.taskId && (a.party !== 'self' || (a.role === 'member') === (b.role === 'member'));
/** An end as a row names it: its party, a member by its agent, and another Task by its ID and title as well (the open Task is the one open). */
const nameEnd = (end: FlowEnd, agent = recordedAgent(end)): NameEnd => {
  const said = agent ? { agent } : {};
  return end.party === 'self' ? end.role === 'member' ? { party: 'member', ...said } : { party: 'self', ...said }
    : { party: end.party, ...(end.taskId === undefined ? {} : { taskId: end.taskId }), ...(end.title === undefined ? {} : { title: end.title }), ...said };
};

/**
 * The one rule for what a row says of who spoke to whom: both ends, from on the left and to on the right, the open Task's
 * responsible as "this Task", each by the agent that stood there (end-agent) when `agent` can say it.
 */
export function rowName({ from, to }: Flow, agent?: (end: FlowEnd, side: 'from' | 'to') => string | undefined): RowName {
  const named = (end: FlowEnd, side: 'from' | 'to') => nameEnd(end, agent ? agent(end, side) : recordedAgent(end));
  return !to || sameEnd(from, to) ? { own: named(from, 'from') } : { ends: [named(from, 'from'), named(to, 'to')] };
}

/**
 * The one rule for which way a record went, read from the chain of command and never from its kind: you are above the
 * Coordinator, the Coordinator above every Task, a Task above the Tasks under it, and a Task's responsible above its members.
 */
export function rowWay({ from, to }: Flow, taskOf: TaskLookup): RowWay {
  if (!to || sameEnd(from, to)) return 'by';
  return above(to, from, taskOf) ? 'up' : above(from, to, taskOf) ? 'down' : 'by';
}
const LINE: Partial<Record<Party, number>> = { parent: 0, self: 1, child: 2 };
function above(high: FlowEnd, low: FlowEnd, taskOf: TaskLookup): boolean {
  if (high.party === 'you') return low.party !== 'you';
  if (high.party === 'coordinator') return low.party !== 'you' && low.party !== 'coordinator';
  if (!high.taskId || high.role === 'member' || !low.taskId) return false;
  if (low.role === 'member' && low.taskId === high.taskId) return true;
  // The open Task's parent, the open Task and its children stand in one line whatever the tree index has read yet.
  const line = LINE[high.party], under = LINE[low.party];
  if (line !== undefined && under !== undefined) return line < under;
  // The Tasks above the lower end, nearest first, until the tree no longer says (a lap stops it).
  const seen = new Set<string>();
  for (let id = taskOf(low.taskId)?.parentId; id && !seen.has(id); id = taskOf(id)?.parentId) {
    if (id === high.taskId) return true;
    seen.add(id);
  }
  return false;
}

/** The record a row's address stands for, as History reads and acquires it: a dialogue's reply is part of its dialogue. */
export const recordKey = (address: string) => address.endsWith(':reply') ? address.slice(0, -':reply'.length) : address;

/** Who a record is from and to, as a row says it: the party, its Task, and a member or the responsible by its agent. */
function sameWordEnd(a: FlowEnd | null, b: FlowEnd | null): boolean {
  if (!a || !b) return !a && !b;
  return a.party === b.party && (a.taskId ?? '') === (b.taskId ?? '') && (a.role ?? '') === (b.role ?? '')
    && (a.profileKey ?? '') === (b.profileKey ?? '') && (a.modelId ?? null) === (b.modelId ?? null) && (a.effort ?? null) === (b.effort ?? null);
}
/** Two rows say the same words: the same kind from and to the same people, about the same Task, in the same words. */
const sameWords = (a: Said, b: Said) => !!a.report.text && !a.report.replyTo && a.report.kind !== 'dialogue'
  && a.report.kind === b.report.kind && a.report.taskId === b.report.taskId && a.report.text === b.report.text
  && sameWordEnd(a.flow.from, b.flow.from) && sameWordEnd(a.flow.to, b.flow.to);
/**
 * Whether two values of a read say the same: equal primitives, or arrays and plain objects whose entries say the same
 * (a key whose value is undefined counts as absent, as a read's JSON has it). Compared in place, never serialized.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let at = 0; at < a.length; at++) if (!sameValue(a[at], b[at])) return false;
    return true;
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter(key => right[key] !== undefined).length) return false;
  for (const key of keys) if (!sameValue(left[key], right[key])) return false;
  return true;
}
/**
 * The one rule for when a record may stand in another's row: everything a row says of it is the same, beyond its words
 * and who it is between: the note on it, whom it asks and how that ended, the state it set as its colour says it
 * (reportTone: a stop under a done's words is not a second done), whether it was taken in, what it was written
 * after, and the result it came back with. The fold guard compares its body first. Only its time differs, and the folded row says that.
 */
const details = ({ report }: Said) => ([report.note ?? null, report.askedTo ?? null, report.released ?? null,
  report.userQuestion ?? false, report.changed ?? null, reportTone(report), report.by ?? null, report.answers ?? null, report.quote ?? null, report.answerText ?? null,
  !!report.consumedBy?.length, report.causes?.map(cause => [cause.taskId, cause.id]) ?? null, report.result?.runId ?? null]);
/** A record that is still to be acted on keeps its own row: an open question, a review waiting, a Run to close. */
const settled = (report: ReportEvent) => !report.pinned && !report.question && !report.runId && !report.finish;

/** The same record over again, one after another, is one row that says how many times. */
function foldRepeats(rows: readonly Said[]): (Said & { older: ReportEvent[]; sameTitle: boolean })[] {
  const out: (Said & { older: ReportEvent[]; sameTitle: boolean })[] = [];
  for (const row of rows) {
    const above = out.at(-1), words = !!above && sameWords(above, row);
    if (above && words && settled(row.report) && (above.report.description ?? null) === (row.report.description ?? null)
      && sameValue(details(above), details(row))) above.older.push(row.report);
    // The row says how it differs from the one above only when that is what it says: its body or its note.
    else out.push({ ...row, older: [], sameTitle: words && (above.report.description !== row.report.description
      || !sameValue(above.report.note ?? null, row.report.note ?? null)) });
  }
  return out;
}

/** Why a wait closed without its answer, from the next record of its Task: the closure alone says only that it did. */
function closedBy(report: ReportEvent, why: Released, next: ReportEvent | undefined, closing: ReportEvent | undefined): RowOutcome {
  if (why === 'stopped' || why === 'expired') return { kind: 'closed', why };
  // A Task has one wait at a time, so the next withdrawal of its Task is this one's. What came after it did not close it.
  const question = report.kind === 'question';
  if (!next || closing && next.at > closing.at) return { kind: 'closed', why };
  return next.kind === 'request' ? { kind: 'resumed', question } : { kind: next.text === report.text ? 'again' : 'replaced', question };
}

/**
 * History's rows, newest first: every record that has something to say is a row, none under another, each saying who it
 * came from or went to as seen from the open Task. Only a record repeating the one above word for word shares its row.
 * What a row cannot say by itself (how a wait ended) is read from the records after it, here and nowhere else.
 */
export function historyRows(reports: readonly ReportEvent[], open: OpenTask, taskOf: TaskLookup, agentAt?: EndAgent): HistoryRow[] {
  // The open Task's own parent is known whether or not the tree index has it yet, so a way up from it is too.
  const treeOf: TaskLookup = id => taskOf(id) ?? (id === open.id ? { parentId: open.parentId, title: '' } : undefined);
  const flowOf = (report: ReportEvent) => reportFlow(report, open, taskOf);
  const shown: Said[] = [];
  const show = (report: ReportEvent) => shown.push({ report, flow: flowOf(report) });
  /**
   * A dialogue is one record of two people's words: the reply stands as the Coordinator's own row, above what it answers,
   * and your words are the record's own row, whose body they are, read whole when it opens as any row whose words are its
   * body. Each row is its own address (its key): the record's for your words, `:reply` added for the reply.
   */
  for (const report of reports) {
    if (displayKind(report) === 'record') continue;
    if (report.kind !== 'dialogue') show(report);
    else {
      if (report.description) show({ ...report, key: `${report.key}:reply`, replyTo: report.key, text: firstReportLine(report.description) });
      show({ ...report, description: report.text || null });
    }
  }
  const answers = new Map<string, Said>();
  const questions = new Map<string, string>();
  // Oldest last: a later answer to a closed question is a Request, so the first answer that closed it is the oldest here.
  for (const row of shown) {
    const { report } = row;
    if (report.kind === 'question') questions.set(`${report.taskId}:${report.id}`, report.text);
    else if (report.kind === 'answer' && report.answers) answers.set(`${report.taskId}:${report.answers}`, row);
  }
  // Read newest first once: the last seen record of a Task is the nearest one after its older wait.
  // An owner's Request can resume either kind of wait; a member's Request cannot.
  const following = new Map<string, { question?: ReportEvent; review?: ReportEvent; withdrawn?: ReportEvent }>();
  const afterWait = new Map<string, { next?: ReportEvent; closing?: ReportEvent }>();
  const confirms: ReportEvent[] = [];
  for (const report of reports) {
    if (report.kind === 'confirm') confirms.push(report);
    let next = following.get(report.taskId);
    if (!next) following.set(report.taskId, next = {});
    if ((report.kind === 'question' || report.kind === 'review') && report.released)
      afterWait.set(report.key, { next: next[report.kind], closing: next.withdrawn });
    if (report.kind === 'request' && report.recipient?.role !== 'member') next.question = next.review = report;
    else if (report.kind === 'question' || report.kind === 'review' || report.kind === 'withdrawn') next[report.kind] = report;
  }
  const outcomeOf = ({ report, flow }: Said): RowOutcome | null => {
    if (report.kind !== 'question' && report.kind !== 'review') return null;
    const answer = report.kind === 'question' ? answers.get(`${report.taskId}:${report.id}`) : undefined;
    // A question asked of the person is answered by them, whoever carried their words to it (the coordinator does).
    if (answer) return { kind: 'answered', who: report.askedTo === 'user' ? 'you' : nameEnd(answer.flow.from).party, at: answer.report.at };
    if (report.released) {
      const after = afterWait.get(report.key)!;
      return closedBy(report, report.released, after.next, after.closing);
    }
    if (report.pinned) return { kind: 'waiting', on: report.userQuestion || report.kind === 'review' || !flow.to ? 'you' : nameEnd(flow.to).party, review: report.kind === 'review' };
    if (report.kind === 'review') for (let i = confirms.length - 1; i >= 0; i--) {
      const confirm = confirms[i]!;
      if (confirm.taskId === report.taskId && confirm.at >= report.at)
        return { kind: 'confirmed', who: nameEnd(flowOf(confirm).from).party, at: confirm.at };
    }
    return null;
  };
  return foldRepeats(shown).map(row => {
    const asks = row.report.kind === 'answer' && row.report.answers ? questions.get(`${row.report.taskId}:${row.report.answers}`) : undefined;
    return { key: row.report.key, report: row.report, flow: row.flow, name: rowName(row.flow, agentAt && ((end, side) => agentAt(end, row.report.at, side))), way: rowWay(row.flow, treeOf), older: row.older, sameTitle: row.sameTitle,
      outcome: outcomeOf(row), ...(asks ? { asks } : {}) };
  });
}

/** Which row opens for each address: its own row, and the row of the repeat a record is part of. */
export const rowTargets = (rows: readonly HistoryRow[]) => {
  const targets = new Map<string, string>();
  for (const row of rows) {
    targets.set(row.key, row.key);
    for (const report of row.older) targets.set(report.key, row.key);
  }
  return targets;
};

/** Whether two reads of a row draw the same: a page read again brings new objects of the same records, and a long History must not draw every row again. */
export function sameRow(a: HistoryRow, b: HistoryRow): boolean {
  const same = sameValue;
  const fields = (x: object, y: object) => {
    const left = x as Record<string, unknown>, right = y as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => same(left[key], right[key]));
  };
  return a === b || a.sameTitle === b.sameTitle && a.way === b.way && a.asks === b.asks && same(a.name, b.name) && same(a.outcome, b.outcome)
    && a.older.length === b.older.length && a.older.every((each, at) => fields(each, b.older[at]!)) && fields(a.report, b.report) && same(a.flow, b.flow);
}

/**
 * An answer as a sentence: each chosen choice's word, without the number a choice is answered with, then the person's
 * own words. Other is said by those words alone (its word is the app's, never the person's), so with Other they are its
 * first line of words, on the answers' line or below it; with chosen choices only, only their line is the sentence (what
 * follows is their reason).
 */
export function answerLine(words: string) {
  const chosen: string[] = [];
  let rest = words.trim(), other = false;
  for (let token; (token = /^[1-9]\d*-(\S+)[ \t]*/.exec(rest)); rest = rest.slice(token[0].length))
    if (token[1] === OTHER_WORD) other = true; else chosen.push(token[1]!);
  const said = firstReportLine(other || !chosen.length ? rest : rest.split('\n')[0]!);
  return [...chosen, said].filter(Boolean).join(' ');
}
