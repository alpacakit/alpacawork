/**
 * A coordinator draft's lifecycle: the one rule for what may change its Task labels, which are all its recipients.
 *
 * - `prepared`: nothing of the person's is in it yet. Opening another Task puts that Task's label in, in place of what
 *   is there (the screen's seed).
 * - `composing`: the person wrote, chose an answer, put a label in or took one off. What the screen opens no longer
 *   changes it, while anything of theirs is left in it. With nothing left, what the person opens (a Task in the panel,
 *   a project chosen) seeds it again; the project coming back into view behind a closed panel opens nothing, so it does
 *   not.
 * - Files say nothing about recipients: attaching leaves the phase as it is, and a seed or a close keeps the files.
 * - `seen`: the last Task the screen was observed to open, kept in either phase. Opening the Task already seen is no
 *   new opening, so it never seeds again.
 * - The screen leaving a Task whose label is all the draft holds (files aside) takes that label off, in either phase, so
 *   nothing is left to go to a Task no longer in view: the panel closing on it, or the project in view changing from it.
 *   Anything else in it keeps the draft as it is.
 *
 * A locally submitted send leaves the current labels as prepared context; its body is retained only for delivery/recovery.
 * Admission consumes that retained body, never restores recipients from it. `seen` is carried: the same panel adds nothing,
 * another opened Task replaces the labels. A refused send comes back as it was sent, `composing`. The phase is the draft's
 * own record; what is written is read only to see that nothing is left.
 */
import { attachmentsOf } from '@/domain/attachments';
import { draftDocument, emptyDocument, inlines, taskLabel, taskReferencesIn, type Document } from './document';

type Values = Record<string, string>;
type Seed = { id: string; title: string };

const hasFiles = (values: Values) => !!values.uploadOps || attachmentsOf(values).length > 0;
/** Only a draft the owner explicitly prepared is a screen seed; an existing draft is never presumed untouched. */
const written = (values: Values) => values.phase !== 'prepared';
/** Anything of the person's in the input, files included: what a whole other draft may not take the place of. */
export const composing = (values: Values) => written(values) || hasFiles(values);
/** The person's words with nothing left in them: no words, label or answer. Spaces, line breaks and files are nothing. */
export const emptied = (values: Values) => written(values)
  && inlines(draftDocument(values)).every(node => node.type === 'hardBreak' || node.type === 'text' && !node.text.trim());
/** The person has changed it: written in, `composing`. A transform that changes nothing changes no phase. */
export function edited(values: Values, transform: (current: Document) => Document): { values: Values; document: Document } | null {
  const current = draftDocument(values);
  // Capture before calling: a transform may edit the document in place.
  const before = JSON.stringify(current);
  const next = transform(current);
  const doc = JSON.stringify(next);
  if (before === doc) return null;
  const { readerDraftTask, readerDraftTurn, ...rest } = values;
  // A recovered answer's binding ends when its Task leaves the edited document.
  const bound = readerDraftTask && taskReferencesIn(next, []).has(readerDraftTask) ? values : rest;
  return { values: { ...bound, phase: 'composing', doc }, document: next };
}
/**
 * The screen opened `task`, in the panel or else as the project in view: seeded while prepared, only noted while
 * composing; nothing when it is the one already seen. An emptied draft is seeded only by what the person opened just
 * now (`chosen`: a Task in the panel, a project chosen), and what `seen` held stays until then, so a label taken off
 * does not come back through closing and reopening the panel; the screen
 * observes again when the draft stops being emptied, so what is in view is noted before any send. A seed is no longer
 * the reader draft an emptied one may have been: that card's binding goes with its words.
 */
export function observed(values: Values, task: Seed, chosen = true): Values | null {
  if ((values.seen ?? '') === task.id) return null;
  const nothingLeft = emptied(values);
  if (nothingLeft && !chosen) return null;
  if (written(values) && !nothingLeft) return { ...values, phase: 'composing', seen: task.id };
  const { readerDraftTask: _task, readerDraftTurn: _turn, ...rest } = values;
  return { ...rest, phase: 'prepared', seen: task.id, doc: JSON.stringify(labelsDocument([task])) };
}
/**
 * The screen left `task` (the panel closed on it, or it was the project in view). With its label all that is in the
 * draft (blank words, line breaks and files are nothing), however it came in, the draft is fresh again: prepared, empty,
 * nothing seen, so the same Task opened again seeds it.
 */
export function closed(values: Values, task: string): Values | null {
  const left = inlines(draftDocument(values)).filter(node => node.type !== 'hardBreak' && (node.type !== 'text' || node.text.trim()));
  if (!left.length || !left.every(node => node.type === 'taskLabel' && node.attrs.id === task)) return null;
  const { readerDraftTask: _task, readerDraftTurn: _turn, ...rest } = values;
  return { ...rest, phase: 'prepared', seen: '', doc: JSON.stringify(emptyDocument()) };
}
/** What a line the screen offers makes of the draft: it takes a prepared draft's place, and goes after one that is the person's. */
export const withLine = (values: Values, line: Document['content'][number]) => (current: Document): Document =>
  ({ type: 'doc', content: composing(values) ? [...current.content, line] : [line] });
/**
 * An example the person picked. With nothing of theirs in the draft it stays prepared, so the next example takes its
 * place; its project counts as seen, so the screen's next look at that project does not seed over it. After their own
 * words it is one more line of theirs.
 */
export function offered(values: Values, line: Document['content'][number], project: Seed | null): Values | null {
  if (composing(values) && !emptied(values)) return edited(values, withLine(values, line))?.values ?? null;
  const { readerDraftTask: _task, readerDraftTurn: _turn, ...rest } = values;
  return { ...rest, phase: 'prepared', doc: JSON.stringify({ type: 'doc', content: [line] }), ...project ? { seen: project.id } : {} };
}
/** Local submission prepares the visible next input; the outbox still retains the original body until admission. */
export const submitted = (values: Values, requestId: string): Values => ({ ...values, phase: 'prepared', requestId });
/** Admission leaves the current input's remaining labels, with what was seen; it never restores the sent recipients. */
export function afterSend(values: Values, remaining: Document): Values {
  return { doc: JSON.stringify(contextLabels(remaining)), phase: 'prepared', seen: values.seen ?? '', requestId: crypto.randomUUID() };
}
/** Task recipients remain the context for the next message, including when it was already being written. */
function contextLabels(current: Document): Document {
  const labels = [...new Map(inlines(current).flatMap(node => node.type === 'taskLabel' ? [[node.attrs.id, node.attrs] as const] : [])).values()];
  return labelsDocument(labels);
}
/** A refused send back in its input: its own words and labels, composing; what the screen has seen since stays. */
export const restored = (sent: Values, input: Values): Values => ({ ...sent, phase: 'composing', seen: input.seen ?? '' });

function labelsDocument(tasks: readonly Seed[]): Document {
  if (!tasks.length) return emptyDocument();
  return { type: 'doc', content: [{ type: 'paragraph', content: tasks.map(task => taskLabel(task)) }] };
}
