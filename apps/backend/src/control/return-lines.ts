/**
 * The only drawer of the lines a seat is woken with: the returns that close its Requests, and the notices (a question
 * with its full text and how to answer it, an urgent note, an answer, a new responsible with what it takes over, a new
 * child). What does not fit the budget becomes the command that reads it. The router's wakes and the start text's
 * carried returns are drawn here; the caller reads every fact a line needs at its read point.
 */
import { isNotice, questionText } from '@alpacawork/contract';
import type { RunId } from '@alpacawork/contract/fields';
import { runNumber } from '@alpacawork/contract/run';
import type { FieldItem, TaskState } from '@alpacawork/raw';
import type { StoredRequest, StoredReturn } from '@alpacawork/runs';
import type { Obligations, ReturnLifecycle } from './return-lifecycle.js';
import type { ReturnClosure, ReturnNotice } from './return-rules.js';

/** One return to draw (`id` is the return's), with the facts its line says. */
export type ReturnLine = { id: string } & (
  /** A Request closed: by a worker's Run, or by the child Task it asked, with why it failed or stopped. */
  | { outcome: ReturnClosure; request: Pick<StoredRequest, 'id' | 'body'>;
    from: { by: 'worker'; placementId: string; runId: RunId | null; reason?: string | null } | { by: 'child'; taskId: string; reason: string | null } }
  /** A question a Task asked, with its full text (contract questionText of what it fixed). */
  | { outcome: 'question'; taskId: string; questionId: string; title: string; text: string }
  | { outcome: 'urgent'; taskId: string; reason: string }
  /** The answer to a question the Task asked, with its fixed text. */
  | { outcome: 'answer'; taskId: string; questionId: string; text: string; closureReason?: 'destination_invalid' }
  /** Open work is supplied once by the launch's common section, including a handover into an existing conversation. */
  | { outcome: 'handover'; taskId: string; state: TaskState }
  | { outcome: 'work_changed'; taskId: string; causeId: string }
  | { outcome: 'child_added'; taskId: string; title: string });

/**
 * How a child Task's Request closed. A worker's Run only succeeds, fails, stops or waits for a person, and says its
 * success, its stop and its wait in its own words.
 */
const CHILD_WORDS: Record<ReturnClosure, string> = { succeeded: 'done', failed: 'failed', stopped: 'stopped',
  needs_review: 'needs review', closed: 'closed (no owner, archived or deleted)', moved: 'moved' };
const WORKER_WORDS: Partial<Record<ReturnClosure, string>> = { succeeded: 'succeeded', stopped: 'Run stopped',
  needs_review: 'needs review (conversation in use)' };
const NOTICE_WORDS: Record<ReturnNotice, string> = { question: 'question', urgent: 'urgent note', answer: 'answer',
  work_changed: 'work changed', handover: 'handover', child_added: 'child added' };

/** The words a line says its outcome with: a child's end, a worker's, or a notice's kind. */
export function outcomeWords(line: ReturnLine): string {
  if (!('from' in line)) return NOTICE_WORDS[line.outcome];
  return line.from.by === 'worker' ? WORKER_WORDS[line.outcome] ?? CHILD_WORDS[line.outcome] : CHILD_WORDS[line.outcome];
}

/** The first line of a Request's text, as its name. */
const headline = (body: string) => [...(body.split('\n')[0] ?? '')].slice(0, 40).join('');
/** A reason on one line, cut to `chars` characters. */
function oneLine(text: string, chars: number): string {
  const characters = [...text.replace(/\s+/g, ' ').trim()];
  return characters.length > chars ? `${characters.slice(0, chars).join('')}…` : characters.join('');
}
const questionCommand = (taskId: string, questionId: string) =>
  `alpacawork task get --task ${taskId} --question ${questionId}`;

/** The one drawer of open work, independent of whether a new conversation or a handover needs it. */
export function openWorkLines(taskId: string, { requests, returns }: Obligations): { full: string; short: string } {
  const read = `alpacawork task get --task ${taskId} --include openObligations`;
  const open = requests.map(request => `- ${request.taskId === taskId ? `Member ${request.placementId}` : `Child task ${request.taskId}`}` +
    ` (request ${request.id} "${headline(request.body)}"${request.runId ? `, Run ${request.runId}` : ''})`);
  const waiting = `Returns and notices not yet handled: ${returns.length} — alpacawork task returns --task ${taskId}`;
  return {
    full: [...open.length ? [`Open requests: ${open.length}`, ...open] : ['No open requests.'],
      ...returns.length ? [waiting] : [], `Request texts, recipients and Runs: ${read}`].join('\n'),
    short: `Open requests: ${requests.length}; returns and notices not yet handled: ${returns.length}. Too large to include; read them with ${read}.`,
  };
}

/**
 * A line in full, and the shorter form that names the command reading what it leaves out (a question's or an answer's
 * text, a handover's open work); a line with nothing to leave out has one form.
 */
function forms(line: ReturnLine): { full: string; short: string } {
  const words = outcomeWords(line);
  const one = (text: string) => ({ full: text, short: text });
  switch (line.outcome) {
    case 'question': {
      const head = `- Task ${line.taskId}: ${words} ${line.questionId} "${line.title}"`;
      const answer = `  How to answer: alpacawork task request --task ${line.taskId} --answers ${line.questionId} --instruction-file -`;
      return { full: [`${head}:`, line.text, answer].join('\n'),
        short: [`${head} — full text: ${questionCommand(line.taskId, line.questionId)}`, answer].join('\n') };
    }
    case 'answer': {
      if (line.closureReason === 'destination_invalid')
        return one(`- Task ${line.taskId}: question ${line.questionId} expired because a move made its recipient invalid. Read the current ancestors and ask a new question if you still need one — ${questionCommand(line.taskId, line.questionId)}`);
      const head = `- Task ${line.taskId}: ${words} to question ${line.questionId}`;
      const question = `  Full text of the question: ${questionCommand(line.taskId, line.questionId)}`;
      return { full: [`${head}:`, line.text, question].join('\n'),
        short: `${head} — full text: ${questionCommand(line.taskId, line.questionId)}` };
    }
    case 'urgent':
      return one(`- Task ${line.taskId}: ${words}: ${line.reason} — alpacawork task get --task ${line.taskId} --log 5`);
    case 'handover': {
      const head = `- Task ${line.taskId}: ${words}: you are now its owner. Current state: ${line.state}. `;
      return one(`${head}Read the open work in the launch prompt's "Open work" section and with alpacawork task get --task ${line.taskId} --include openObligations, ` +
        `the questions and values with alpacawork task get --task ${line.taskId} --include closedQuestions, and the returns and notices with alpacawork task returns --task ${line.taskId}.`);
    }
    case 'work_changed': return one(`- Task ${line.taskId}: ${words} (cause ${line.causeId}) — alpacawork task get --task ${line.taskId} --log 5`);
    case 'child_added':
      return one(`- Child task ${line.taskId} "${line.title}": ${words} — alpacawork task get --task ${line.taskId}`);
    default: {
      const request = `request "${headline(line.request.body)}"`;
      if (line.from.by === 'worker')
        return one(`- Member ${line.from.placementId}: ${words} (${request})` +
          (line.from.reason ? ` (cause: ${oneLine(line.from.reason, 200)})` : '') +
          (line.from.runId === null ? '' : ` — alpacawork run get --run ${line.from.runId}`));
      const reason = line.from.reason === null ? '' : ` (cause: ${oneLine(line.from.reason, 200)})`;
      return one(`- Child task ${line.from.taskId}: ${words}${reason} (${request}) — alpacawork task get --task ${line.from.taskId}`);
    }
  }
}

/**
 * The lines of `rows` in their order within `budget` bytes (MAX_INSTRUCTION_BYTES for a wake), and the IDs of the
 * returns drawn. A line that does not fit in full is drawn in its shorter form; from the first that does not fit even
 * so, the rest are named by how many and where they are read. The budget holds at least the first and the last line.
 */
export function returnLines(rows: readonly ReturnLine[], budget: number): { body: string; ids: string[] } {
  const header = `Returns and notices that arrived (${rows.length}):`;
  const rest = (count: number) => count ? `\n${count} more do not fit here. Read them with alpacawork task returns --task <this task's ID>.` : '';
  const lines: string[] = [], ids: string[] = [];
  let used = Buffer.byteLength(header);
  for (const [index, row] of rows.entries()) {
    const after = Buffer.byteLength(rest(rows.length - index - 1));
    const { full, short } = forms(row);
    const line = [full, short].find(form => used + 1 + Buffer.byteLength(form) + after <= budget);
    if (line === undefined) break;
    lines.push(line); ids.push(row.id);
    used += 1 + Buffer.byteLength(line);
  }
  return { body: [header, ...lines].join('\n') + rest(rows.length - ids.length), ids };
}

/**
 * The facts return-lines draws each of `rows` with, at the lifecycle's read point: the Request a closing return closes
 * and who closed it (a worker's Run, or the child Task with why it failed or stopped), a question's full text, an answer's
 * fixed text, an urgent note's reason, what a new responsible takes over (openObligations), a new child. A seat's
 * wake (ReturnRouter) and the returns a Request carries are drawn from these.
 */
export function returnLinesOf(lifecycle: ReturnLifecycle, rows: readonly StoredReturn[]): ReturnLine[] {
  const { db, tx } = lifecycle;
  const logs = new Map(lifecycle.tasks.flatMap(task => task.meta.log.map(log => [log.id, { log, task }] as const)));
  const requests = tx.getRequests(rows.flatMap(row => !isNotice(row.outcome) && row.requestId !== null ? [row.requestId] : []));
  const runs = tx.getMany([...requests.values()].flatMap(request => request.runId === null ? [] : [request.runId]));
  const fixedIds = rows.flatMap(row => {
    const cause = row.causeLogId === null ? undefined : logs.get(row.causeLogId);
    return cause && row.outcome === 'answer' && cause.log.kind !== 'question_expired'
      ? [cause.log.id] : [];
  });
  const texts = new Map(fixedIds.length ? db.prepare(`SELECT log_id,text FROM log_texts
    WHERE log_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...new Set(fixedIds)]))
    .map(row => [String(row.log_id), row.text]) : []);
  const boundaryIds = rows.flatMap(row => {
    const request = row.requestId === null ? undefined : requests.get(row.requestId);
    return request?.runId && runs.get(request.runId)?.role === 'worker' && row.boundaryRunId
      ? [runNumber(row.boundaryRunId)] : [];
  });
  const diagnostics = new Map(boundaryIds.length ? db.prepare(`SELECT run_no,diagnostic FROM run_attempts
    WHERE run_no IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...new Set(boundaryIds)]))
    .map(row => [Number(row.run_no), row.diagnostic]) : []);
  return rows.map((row): ReturnLine => {
    const required = <Value>(value: Value | null | undefined, what: string): Value => {
      if (value === null || value === undefined) throw new Error(`Return ${row.id} has no ${what}`);
      return value;
    };
    const fixed = (logId: string) =>
      String(required(texts.get(logId), 'fixed text'));
    const cause = row.causeLogId === null ? undefined : logs.get(row.causeLogId);
    if (!isNotice(row.outcome)) {
      const request = required(row.requestId === null ? null : requests.get(row.requestId), 'Request');
      const worker = request.runId !== null && runs.get(request.runId)?.role === 'worker';
      const why = row.outcome === 'failed' || row.outcome === 'stopped'
        ? cause?.log.description ?? cause?.log.title ?? null : null;
      const diagnostic = worker && row.boundaryRunId ? diagnostics.get(runNumber(row.boundaryRunId)) : null;
      const failure = diagnostic ? JSON.parse(String(diagnostic)) : null;
      const workerReason = failure?.kind === 'launch_aborted' ? failure.cause?.message ?? null : null;
      return { id: row.id, outcome: row.outcome, request: { id: request.id, body: request.body },
        from: worker ? { by: 'worker', placementId: request.placementId, runId: row.boundaryRunId, ...(workerReason ? { reason: workerReason } : {}) }
          : { by: 'child', taskId: request.taskId, reason: why } };
    }
    const { log, task } = required(cause, 'cause log');
    switch (row.outcome) {
      case 'question': return { id: row.id, outcome: 'question', taskId: task.id, questionId: log.id,
        title: required(log.title, 'question title'), text: questionText(required(log.decide, 'question') as FieldItem[]) };
      case 'urgent': return { id: row.id, outcome: 'urgent', taskId: task.id,
        reason: required(log.urgentReason, 'urgent reason') };
      case 'answer': return { id: row.id, outcome: 'answer', taskId: task.id,
        questionId: required(log.questionId, 'question'),
        ...(log.kind === 'question_expired' ? { text: '', closureReason: 'destination_invalid' as const } : { text: fixed(log.id) }) };
      case 'handover': return { id: row.id, outcome: 'handover', taskId: task.id, state: task.meta.state };
      case 'work_changed': return { id: row.id, outcome: 'work_changed', taskId: task.id, causeId: log.id };
      case 'child_added': return { id: row.id, outcome: 'child_added', taskId: task.id, title: task.meta.title };
    }
  });
}
