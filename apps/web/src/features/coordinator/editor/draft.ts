import { flushSync } from 'react-dom';
import type { Editor as TiptapEditor } from '@tiptap/core';
import type { SentIntent } from '../reader-send';
import { readerTurn } from '@/features/reader/submission';
import type { Task } from '@/data/types';
import { clearedEditableIntent, editableIntentValues } from './editable-intent';
import { create } from 'zustand';
import { useMemo } from 'react';
import { useStoredDraft, useDraftStore, draftKey, transferDraft, writeDrafts } from '@/features/forms/draft-store';
import { useWorkspaceInfo } from '@/data/queries';
import { useConversation, type AnswerAt } from '../coordinator';
import { NARROW_QUERY } from '@/state/view-store';
import { draftDocument, emptyDocument, hasReaderOperation, filterDocument, inlines, toggleAnswer, replyIn, replyTo, documentSchema, taskLabel, sameAnswer, automationIn, aboutAutomation, type AutomationBadge, type Document, type Inline } from './document';
import { badged, closed, composing, edited, observed, offered, unbadged, withLine } from './lifecycle';
import { projectInput, editProjectedInput, type InputEdit } from './input-ownership';

const useVoiceLock = create<{ key: string | null }>(() => ({ key: null }));
const editingEntry = (key: string) => {
  const entry = useDraftStore.getState().entries[key];
  return entry?.status === 'editing' ? entry : null;
};
/** The entry to write to now: being edited, and not held by voice. Voice's own words write to `editingEntry` past its hold. */
const writableEntry = (key: string) => useVoiceLock.getState().key === key ? null : editingEntry(key);

/** The single write boundary for changes to what the input currently shows. */
export function mutateInput(key: string, transform: (visible: Record<string, string>) => Record<string, string> | null, edit?: InputEdit, voice = false): boolean {
  const entry = voice ? editingEntry(key) : writableEntry(key);
  if (!entry) return false;
  const entries = useDraftStore.getState().entries;
  const values = transform(projectInput(entries, key)!);
  return values ? writeDrafts(editProjectedInput(entries, key, values, edit)) : false;
}

/** One canonical document, even while the editor is closed. No independently writable answer store. */
export function useInputDraft() {
  const voiceKey = useVoiceLock(state => state.key);
  const id = useConversation(state => state.conversation?.id) ?? 'loading';
  const root = useWorkspaceInfo(info => info.root);
  useMemo(() => {
    if (id === 'loading') return;
    transferDraft(draftKey(root, 'coordinator', 'loading'), draftKey(root, 'coordinator', id), (source, target) => {
      if (!target || target.status === 'saved') return source;
      const incoming = draftDocument(source.values);
      const current = draftDocument(target.values);
      const badge = automationIn(incoming);
      // A badge chosen while loading, with nothing written yet, joins a draft that has none.
      if (!composing(source.values)) return !badge || automationIn(current) ? target
        : { ...target, values: composing(target.values) ? edited(target.values, doc => aboutAutomation(doc, badge))!.values : badged(target.values, badge) ?? target.values };
      const answers = inlines(incoming).filter(node => node.type === 'answerLabel');
      let merged = filterDocument(current, node => node.type !== 'answerLabel' || !answers.some(next => next.type === 'answerLabel' && sameAnswer(next.attrs, node.attrs)));
      for (const next of answers) if (next.type === 'answerLabel') {
        const task = inlines(incoming).find(node => node.type === 'taskLabel' && node.attrs.id === next.attrs.task);
        merged = toggleAnswer(merged, task?.type === 'taskLabel' ? task.attrs : { id: next.attrs.task, title: '' }, next.attrs);
      }
      const words = filterDocument(incoming, node => node.type !== 'replyLabel' && node.type !== 'automationLabel' && node.type !== 'answerLabel' && (node.type !== 'taskLabel' || !answers.some(answer => answer.type === 'answerLabel' && answer.attrs.task === node.attrs.id)));
      if (inlines(words).some(node => node.type !== 'hardBreak')) merged = { ...merged, content: [...merged.content, ...words.content] };
      const reply = replyIn(incoming);
      if (reply && !replyIn(merged)) merged = replyTo(merged, reply);
      if (badge && !automationIn(merged)) merged = aboutAutomation(merged, badge);
      return { ...target, values: { ...target.values, phase: 'composing', doc: JSON.stringify(documentSchema.parse(merged)) } };
    });
  }, [root, id]);
  const draft = useStoredDraft('coordinator', id, () => ({ values: { doc: JSON.stringify(emptyDocument()), phase: 'prepared', requestId: crypto.randomUUID() } }));
  const entries = useDraftStore(state => state.entries);
  const values = useMemo(() => projectInput(entries, draft.key, draft.entry.values)!, [entries, draft.key, draft.entry.values]);
  const doc = useMemo(() => draftDocument(values), [values.doc]);
  // Every change the person makes (the editor, an answer pressed in a report) comes here, and makes it theirs.
  const change = (transform: (current: Document) => Document, voice = false, edit?: InputEdit) => {
    mutateInput(draft.key, values => {
      const changed = edited(values, transform);
      return changed && { ...changed.values, ...(!hasReaderOperation(changed.document) ? clearedEditableIntent() : {}) };
    }, edit, voice);
  };
  /** What the screen shows, the panel's Task over the project in view (each as its index has it): the lifecycle's one seed (lifecycle.ts). */
  const observe = (screen: Parameters<typeof observed>[1]) => {
    mutateInput(draft.key, values => observed(values, screen));
  };
  /** The screen left `task`: the panel closed on it, or it was the project in view (lifecycle.ts). */
  const close = (task: string) => { mutateInput(draft.key, values => closed(values, task)); };
  /** A review's send-back enters the one editable document with the versions actually reviewed. */
  const intend = (task: Task, intent: SentIntent, words: string) => {
    const line: Document['content'][number] = { type: 'paragraph', content: [taskLabel(task),
      { type: 'text', text: ` ${words}`, marks: [{ type: 'readerOperation' }] }] };
    return mutateInput(draft.key, values => {
      const edit = edited(values, current => hasReaderOperation(current) ? current : withLine(values, line)(current));
      return edit && { ...edit.values, ...editableIntentValues(intent, readerTurn(task)) };
    });
  };
  return { ...draft, entry: { ...draft.entry, values }, doc, change, observe, close, intend, locked: voiceKey === draft.key,
    lockVoice: (active: boolean) => { if (active || useVoiceLock.getState().key === draft.key) useVoiceLock.setState({ key: active ? draft.key : null }); },
  };
}

let coordinatorField: { element: HTMLElement; commit: () => void } | null = null;
export function registerCoordinatorField(element: HTMLElement, commit: () => void = () => {}) {
  const field = { element, commit };
  coordinatorField = field;
  return () => { if (coordinatorField === field) coordinatorField = null; };
}
type Editor = TiptapEditor;
/** What the input's focus goes right after: an answer's chip, or a task's label (`{ label: <its id> }`). */
type FocusAt = AnswerAt | { label: string };
/** Right after that chip or label in the editor's document, where its words are written; null when it is not there. */
function afterAtom(editor: Editor, at: FocusAt) {
  let found = null as number | null;
  editor.state.doc.descendants((node, pos) => {
    if ('label' in at ? node.type.name === 'taskLabel' && node.attrs.id === at.label
      : node.type.name === 'answerLabel' && sameAnswer(node.attrs as AnswerAt, at)) found = pos + node.nodeSize;
    return found === null;
  });
  // After a label, past the space put in with it, where # leaves the caret.
  if (found !== null && 'label' in at && editor.state.doc.textBetween(found, Math.min(found + 1, editor.state.doc.content.size)) === ' ') found += 1;
  return found;
}
/** The committed editor and its connected surface deliver the same pending handoff. */
export function applyCoordinatorFocus() {
  const state = useConversation.getState(), registered = coordinatorField, at = state.focusRequested;
  const field = registered?.element;
  if (!at || !state.open || !registered || !field?.isConnected) return;
  // A connected surface can precede React's next draft render. Commit the canonical
  // document before resolving its end/answer position or consuming this handoff.
  registered.commit();
  // Consume before calling into the editor: reparenting must not replay a user request.
  useConversation.setState({ focusRequested: false });
  field.ownerDocument.defaultView?.focus();
  const editor = (field as HTMLElement & { editor?: Editor }).editor;
  if (editor) {
    editor.commands.focus(at === true ? 'end' : afterAtom(editor, at) ?? 'end');
    // Rebuild the native range from the committed editor selection. After restoring
    // atoms, Chromium can report the right range but still type at its old offset.
    field.ownerDocument.getSelection()?.removeAllRanges();
    editor.view.focus();
  } else field.focus();
}
/** Brings the input up with focus: at the end of what is written, or right after an answer's chip or a task's label (`at`). */
export function focusCoordinator(at: true | FocusAt = true) {
  // Commit the connected editor in the activating press, keeping native mobile activation.
  // The commit effects consume this request once, after committing its document.
  flushSync(() => {
    useConversation.setState({ focusRequested: at });
    useConversation.getState().setOpen(true);
  });
}
/**
 * The one way an answer goes from a report into the input: written into the draft, then on a wide screen the input
 * opens on it with focus. On a phone the input stays as it is, up or down, and focus stays where it is: focus in the
 * input raises the keyboard under the press. The answer is in the input when the person brings it up. `write`: the
 * answer put in asks for words to follow (Other), so the input opens with focus right after its chip on a phone too,
 * the keyboard rising for what was pressed for.
 */
export function answerInDraft(draft: Pick<ReturnType<typeof useInputDraft>, 'change'>, transform: (current: Document) => Document, write: AnswerAt | null = null) {
  draft.change(transform);
  if (write) focusCoordinator(write);
  else if (!matchMedia(NARROW_QUERY).matches) focusCoordinator();
  else useConversation.setState(state => ({ written: state.written + 1 }));
}
export function focusReader() {
  document.querySelector<HTMLElement>("[data-reader-title]")?.focus({ preventScroll: true });
}
export function leaveCoordinator() {
  useConversation.getState().setOpen(false); focusReader();
}

/** A label as the input puts one in, by # or from the screen: the label, then a space to write on after it. */
export const labelContent = (type: string, attrs: Record<string, unknown>) => [{ type, attrs }, { type: 'text', text: ' ' }];

/**
 * The one way a task's label goes from the screen into the input (the reader head's insert mark), the label # puts in:
 * where the input's caret is, also while the input is folded (at its start until it has had one, or while the input
 * has never been opened), the input then coming up with focus right after the label. A label of the same task already in the input is not put in twice:
 * the caret goes right after it. Labels of other tasks stay; the message is about each. False when the input cannot be
 * written to now (sending, voice), and nothing changes. Whether the workspace takes writes at all is the press's to
 * know (it is not offered then, as #).
 */
export function taskInDraft(task: { id: string; title: string }): boolean {
  const { root, conversation } = useConversation.getState(), registered = coordinatorField;
  const key = draftKey(root, 'coordinator', conversation?.id ?? 'loading');
  if (!writableEntry(key)) return false;
  const label = labelContent('taskLabel', { id: task.id, title: task.title });
  // A folded input keeps its editor, and its caret, off the page: the caret still says where the label goes.
  const editor = (registered?.element as (HTMLElement & { editor?: Editor }) | undefined)?.editor;
  if (editor && !editor.isDestroyed) {
    if (!editor.isEditable) return false;
    registered!.commit();
    // At the caret's end: words the person selected are theirs, not this press's to replace.
    if (afterAtom(editor, { label: task.id }) === null) editor.chain().insertContentAt(editor.state.selection.to, label).run();
  } else mutateInput(key, values => edited(values, current => inlines(current).some(node => node.type === 'taskLabel' && node.attrs.id === task.id) ? current : atStart(current, label as Inline[]))?.values ?? null);
  focusCoordinator({ label: task.id });
  return true;
}
const atStart = (doc: Document, put: Inline[]): Document => {
  const [first, ...rest] = doc.content;
  return { ...doc, content: [{ ...first ?? { type: 'paragraph' }, content: [...put, ...first?.content ?? []] }, ...rest] };
};

/** Only the reply icon writes this reference; all other editing uses ordinary document operations. */
export function replyInDraft(reply: { id: string; answeredAt: string }) {
  const { root, conversation } = useConversation.getState();
  if (!conversation) return;
  const key = draftKey(root, 'coordinator', conversation.id), entry = writableEntry(key);
  if (!entry) return;
  if (mutateInput(key, values => edited(values, current => replyTo(current, reply))?.values ?? null)) focusCoordinator();
}

/**
 * The one way the screen says which automation the input is about: an automation opened (`{ id, name }`), or `'new'`
 * for one to ask for. Its badge goes in at the input's start (see `badged`). An opening fills only an input with
 * nothing of the person's in it and leaves focus where it is; a press for that automation (`pressed`: "ask to create",
 * or asking about the one open) puts its badge in place of another even beside their words, and brings the input up
 * with focus. False when the input cannot be written to now (sending, voice).
 */
export function automationInDraft(target: { id: string; name: string } | 'new', { pressed = false }: { pressed?: boolean } = {}): boolean {
  const { root, conversation } = useConversation.getState();
  const key = draftKey(root, 'coordinator', conversation?.id ?? 'loading');
  if (!writableEntry(key)) return false;
  const badge: AutomationBadge = target === 'new' ? { id: 'new', name: '' } : { id: target.id as AutomationBadge['id'], name: target.name };
  mutateInput(key, values => badged(values, badge, pressed));
  if (pressed) focusCoordinator();
  return true;
}
/**
 * The screen shows no automation but `kept` (its ID, `'new'` for the page asking for one, null for none): a draft
 * holding only another's badge empties, whenever and by whatever page that badge was put in.
 */
export function automationLeftDraft(kept: string | null) {
  const { root, conversation } = useConversation.getState();
  mutateInput(draftKey(root, 'coordinator', conversation?.id ?? 'loading'), values => unbadged(values, kept));
}

/**
 * An example (the empty conversation's, or the guide's) put in the input, for the person to send or change; its lines
 * kept as lines. Like the screen's other seeds (lifecycle.ts) it takes the place of a prepared draft, another example
 * included, and goes after one the person has made theirs, which is never discarded.
 */
export function exampleInDraft(words: string) {
  const { root, conversation } = useConversation.getState();
  const key = draftKey(root, 'coordinator', conversation?.id ?? 'loading'), entry = writableEntry(key);
  if (!entry) return;
  const line: Document['content'][number] = { type: 'paragraph', content: words.split('\n').flatMap((text, at) =>
    [...at ? [{ type: 'hardBreak' as const }] : [], ...text ? [{ type: 'text' as const, text }] : []]) };
  let unchanged = false;
  const changed = mutateInput(key, visible => {
    const values = offered(visible, line);
    unchanged = !values;
    return values;
  });
  if (unchanged || changed) focusCoordinator();
}
