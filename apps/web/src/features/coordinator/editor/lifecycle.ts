/**
 * A coordinator draft's lifecycle: the one rule for what may change its Task labels, which are all its recipients.
 *
 * The screen shows on two layers: the Task in the panel, over the list narrowed to the project in view.
 *
 * - `prepared`: nothing of the person's is in it yet. An opening puts that Task's label in, in place of what is there
 *   (the screen's seed).
 * - `composing`: the person wrote, chose an answer, put a label in or took one off. What the screen opens no longer
 *   changes it, while anything of theirs is left in it. With nothing left, an opening seeds it again.
 * - Files say nothing about recipients: attaching leaves the phase as it is, and a seed or a close keeps the files.
 * - `seen` and `seenProject`: what each layer was last observed to show, kept in either phase and across reloads. Only
 *   what a layer had not shown is an opening: a Task new in the panel, else a project new in view with no panel over
 *   it. The project under the panel is noted too, so the list come back behind a closed panel opens nothing; a project
 *   opened starts the panel's record afresh, so a Task opened over it next is new.
 * - The screen leaving a Task whose label is all the draft holds (files aside) takes that label off, in either phase, so
 *   nothing is left to go to a Task no longer in view: the panel closing on it or the reader moving on from it once
 *   answered (to the next waiting Task, or the card saying every turn there is answered), or the project in view
 *   changing from it.
 *   Anything else in it keeps the draft as it is.
 *
 * A locally submitted send leaves the current labels as prepared context; its body is retained only for delivery/recovery.
 * Admission consumes that retained body, never restores recipients from it. What was seen is carried: the same panel adds nothing,
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
 * What the screen shows now (`panel` over `project`; null where a layer shows nothing, and a project not known yet
 * left out, which keeps what was seen of it): an opening seeds a prepared or emptied draft and is only noted in one
 * with anything of the person's left; with no opening, what is shown is noted. A project opened starts the panel's
 * record afresh, so any Task opened over it next is new. Null when nothing changes. A seed is no longer the reader
 * draft an emptied one may have been: that card's binding goes with its words.
 */
export function observed(values: Values, screen: { panel: Seed | null; project?: Seed | null }): Values | null {
  const before = { seen: values.seen ?? '', seenProject: values.seenProject ?? '' };
  const seenProject = screen.project === undefined ? before.seenProject : screen.project?.id ?? '';
  const opening = screen.panel ? (screen.panel.id !== before.seen ? screen.panel : null)
    : screen.project && screen.project.id !== before.seenProject ? screen.project : null;
  const seen = screen.panel?.id ?? (opening ? '' : before.seen);
  const noted: Values = { ...values, seen, seenProject };
  if (!opening) return seen === before.seen && seenProject === before.seenProject ? null : noted;
  if (written(values) && !emptied(values)) return { ...noted, phase: 'composing' };
  const { readerDraftTask: _task, readerDraftTurn: _turn, ...rest } = noted;
  return { ...rest, phase: 'prepared', doc: JSON.stringify(labelsDocument([opening])) };
}
/**
 * The screen left `task` (the panel closed on it, or it was the project in view). With its label all that is in the
 * draft (blank words, line breaks and files are nothing), however it came in, the draft is fresh again: prepared, empty,
 * nothing seen on either layer, so what the screen shows next seeds it.
 */
export function closed(values: Values, task: string): Values | null {
  const left = inlines(draftDocument(values)).filter(node => node.type !== 'hardBreak' && (node.type !== 'text' || node.text.trim()));
  if (!left.length || !left.every(node => node.type === 'taskLabel' && node.attrs.id === task)) return null;
  const { readerDraftTask: _task, readerDraftTurn: _turn, ...rest } = values;
  return { ...rest, phase: 'prepared', seen: '', seenProject: '', doc: JSON.stringify(emptyDocument()) };
}
/** What a line the screen offers makes of the draft: it takes a prepared draft's place, and goes after one that is the person's. */
export const withLine = (values: Values, line: Document['content'][number]) => (current: Document): Document =>
  ({ type: 'doc', content: composing(values) ? [...current.content, line] : [line] });
/**
 * An example the person picked. With nothing of theirs in the draft it takes the prepared draft's place after the labels
 * the screen put there (where it goes), and stays prepared, so the next example takes its place. After their own words
 * it is one more line of theirs.
 */
export function offered(values: Values, line: Document['content'][number]): Values | null {
  if (composing(values) && !emptied(values)) return edited(values, withLine(values, line))?.values ?? null;
  const labels = !written(values) && values.doc ? inlines(draftDocument(values)).filter(node => node.type === 'taskLabel') : [];
  const labelled = { ...line, content: [...labels.flatMap(label => [label, { type: 'text' as const, text: ' ' }]), ...line.content ?? []] };
  const { readerDraftTask: _task, readerDraftTurn: _turn, ...rest } = values;
  return { ...rest, phase: 'prepared', doc: JSON.stringify({ type: 'doc', content: [labelled] }) };
}
/** Local submission prepares the visible next input; the outbox still retains the original body until admission. */
export const submitted = (values: Values, requestId: string): Values => ({ ...values, phase: 'prepared', requestId });
/** Admission leaves the current input's remaining labels, with what was seen; it never restores the sent recipients. */
export function afterSend(values: Values, remaining: Document): Values {
  return { doc: JSON.stringify(contextLabels(remaining)), phase: 'prepared', seen: values.seen ?? '', seenProject: values.seenProject ?? '', requestId: crypto.randomUUID() };
}
/** Task recipients remain the context for the next message, including when it was already being written. */
function contextLabels(current: Document): Document {
  const labels = [...new Map(inlines(current).flatMap(node => node.type === 'taskLabel' ? [[node.attrs.id, node.attrs] as const] : [])).values()];
  return labelsDocument(labels);
}
/** A refused send back in its input: its own words and labels, composing; what the screen has seen since stays. */
export const restored = (sent: Values, input: Values): Values => ({ ...sent, phase: 'composing', seen: input.seen ?? '', seenProject: input.seenProject ?? '' });

function labelsDocument(tasks: readonly Seed[]): Document {
  if (!tasks.length) return emptyDocument();
  return { type: 'doc', content: [{ type: 'paragraph', content: tasks.map(task => taskLabel(task)) }] };
}
