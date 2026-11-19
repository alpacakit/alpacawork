import type { ReportEvent } from './report-events';

/** The six parties a Task's History speaks of, as seen from the open Task. */
export type Party = 'you' | 'coordinator' | 'self' | 'child' | 'parent' | 'other';
export type FlowEnd = { party: Party; taskId?: string; title?: string; role?: 'owner' | 'member'; profileKey?: string; modelId?: string | null; effort?: string | null };
/** Where a record came from and where it went. `to` is null for a record with no addressee. */
export type Flow = { from: FlowEnd; to: FlowEnd | null };
export type OpenTask = { id: string; parentId: string | null };
export type TaskLookup = (id: string) => { parentId: string | null; title: string } | undefined;

const KINDS_TO_REQUESTER = new Set<ReportEvent['kind']>(['report', 'review', 'urgent', 'error', 'run_end']);

/** What an end's Run ran with, from a record's link to it; none when no Run is linked. */
type Agent = { profileKey?: string; modelId?: string | null; effort?: string | null };
const ran = (agent: Agent | undefined): Agent => agent ? { profileKey: agent.profileKey, modelId: agent.modelId, effort: agent.effort } : {};

/**
 * The one rule for both ends of every History row, read from the record's own links: who wrote it (`author`, `by`),
 * whose log it is in (`taskId`, `sourceTaskId`), and who it names (`recipient`, `askedTo`). A Task's relation to the
 * open Task comes from the tree, never from words. Each end carries what its own Run ran with: the writer's, the Run
 * that accepted or took in the record (`recipient`), and the Coordinator's that took the screen message (`coordinator`).
 */
export function reportFlow(report: ReportEvent, open: OpenTask, taskOf: TaskLookup): Flow {
  const task = (id: string): FlowEnd => {
    const row = taskOf(id), title = row?.title;
    const party: Party = id === open.id ? 'self' : id === open.parentId ? 'parent' : row?.parentId === open.id ? 'child' : 'other';
    return { party, taskId: id, ...(title === undefined ? {} : { title }) };
  };
  const home = task(report.taskId);
  const author = report.author;
  const coordinator: FlowEnd = { party: 'coordinator', ...ran(report.coordinator) };
  // A dialogue's reply is the Coordinator's words back to you, though the record is yours.
  if (report.replyTo) return { from: coordinator, to: { party: 'you' } };
  const from: FlowEnd = report.kind === 'dialogue' || author?.kind === 'human' || report.by === 'human' ? { party: 'you' }
    : author?.kind === 'main' || report.by === 'main' ? coordinator
      : author?.kind === 'parent' ? { ...task(author.taskId), role: 'owner', ...ran(author) }
        : author?.kind === 'owner' || author?.kind === 'member' ? { ...home, role: author.kind, ...ran(author) }
          : home;
  const to = addressee(report, open, home, from, task, coordinator);
  // A record a Run took in names that Run at its Task end; a Request names the Run that accepted it (addressee).
  return { from, to: to?.taskId && report.kind !== 'request' && report.recipient ? { ...to, ...ran(report.recipient) } : to };
}

function addressee(report: ReportEvent, open: OpenTask, home: FlowEnd, from: FlowEnd, task: (id: string) => FlowEnd, coordinator: FlowEnd): FlowEnd | null {
  // You talk with the Coordinator about the Task whose History holds it: your words go to the Coordinator.
  if (report.kind === 'dialogue') return coordinator;
  if (report.kind === 'request') return { ...home, ...(report.recipient ? { role: report.recipient.role, ...ran(report.recipient) } : {}) };
  if (report.kind === 'question') return report.askedTo === undefined ? null : report.askedTo === 'user' ? { party: 'you' } : task(report.askedTo);
  // An answer goes to the Task that asked, whose log holds it; a confirmation or a state set from outside goes to the Task it acts on.
  if (report.kind === 'answer' || report.kind === 'confirm' || report.changed) return from.party === home.party && from.taskId === home.taskId ? null : home;
  // A member works for its Task's responsible: what it records goes there, whatever record it is.
  if (from.role === 'member' && home.party === 'self') return { ...home, role: 'owner' };
  if (!KINDS_TO_REQUESTER.has(report.kind)) return from.taskId === home.taskId ? null : home;
  // A record that goes to its Task's requester: a child's to the open Task, the open Task's to its parent, or to you at the top of the tree.
  if (home.party !== 'self') return task(open.id);
  return open.parentId === null ? { party: 'you' } : task(open.parentId);
}
