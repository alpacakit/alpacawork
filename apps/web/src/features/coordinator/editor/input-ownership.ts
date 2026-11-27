/** The outbox's portions of the one input. Wire context is not evidence of a body's position. */
import { z } from 'zod';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Mapping, StepMap } from '@tiptap/pm/transform';
import { diffArrays } from 'diff';
import type { DraftEntry } from '@/features/forms/draft-store';
import { attachmentsOf } from '@/domain/attachments';
import { automationIn, documentSchema, documentUnits, draftDocument, hasContent, parseDocument, replyIn, unitsDocument, type DocumentUnit } from './document';
import { afterSend } from './lifecycle';

type Entries = Record<string, DraftEntry>;
type Values = Record<string, string>;
const spanSchema = z.object({ from: z.number().int().nonnegative(), to: z.number().int().positive(), content: documentSchema });
const portionSchema = z.object({ revision: z.string(), spans: z.array(spanSchema) });
type Span = z.infer<typeof spanSchema>;
type Portion = z.infer<typeof portionSchema>;
export const INPUT_PORTION = 'inputPortion';
export type InputEdit = { before: ProseMirrorNode; mapping: Mapping };
const portion = (values: Values): Portion | null => values[INPUT_PORTION] ? portionSchema.parse(JSON.parse(values[INPUT_PORTION])) : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** What stays as the next message's context: Task labels, and an automation's badge (a new one's is the message's own). */
const context = (unit: DocumentUnit) => unit.type === 'taskLabel' || unit.type === 'automationLabel' && unit.attrs.id !== 'new';
/** A reply or badge a newer one has taken the place of leaves the send's own words and files to retain. */
const replaceable = (unit: DocumentUnit) => unit.type === 'replyLabel' || unit.type === 'automationLabel';
const hasBody = (values: Values) => documentUnits(draftDocument(values)).some(unit => !context(unit) && !replaceable(unit));
const bound = (sent: Values, input: string, draft: DraftEntry) => sent.from === input && sent.fresh === draft.values.requestId;
// Delivery may have ended while the complete original still waits to be recovered.
export const retainingInput = (sent: Values) => sent.stage !== 'accepted' && !sent.taken;
const covers = (span: Span, position: number) => span.from <= position && position < span.to;
function validSpans(sent: Values, draft: DraftEntry): Span[] | null {
  const owned = portion(sent), units = documentUnits(draftDocument(draft.values));
  if (!owned || owned.revision !== draft.revision || hasBody(sent) && !owned.spans.length) return null;
  return owned.spans.every(span => span.to > span.from && span.to <= units.length
    && same(units.slice(span.from, span.to), documentUnits(span.content))) ? owned.spans : null;
}
function pendingSpans(entries: Entries, input: string, draft: DraftEntry): Span[] {
  return Object.values(entries).flatMap(entry => bound(entry.values, input, draft) && retainingInput(entry.values)
    ? validSpans(entry.values, draft) ?? [] : []);
}
/** Recipients are shared input context; a send owns only its body, for every kind of message. */
export function claimInput(entries: Entries, input: string): string {
  const draft = entries[input]!, units = documentUnits(draftDocument(draft.values)), occupied = pendingSpans(entries, input, draft);
  const spans: Span[] = [];
  for (let at = 0; at < units.length;) {
    if (context(units[at]!) || occupied.some(span => covers(span, at))) { at++; continue; }
    const from = at++;
    while (at < units.length && !context(units[at]!) && !occupied.some(span => covers(span, at))) at++;
    spans.push({ from, to: at, content: unitsDocument(units.slice(from, at)) });
  }
  return JSON.stringify({ revision: draft.revision!, spans } satisfies Portion);
}
/** A retained original must still have its recipient context as well as its owned body.
 * Changed context uses snapshot recovery instead: the recovery owner can replace prepared context,
 * park another Task's draft, or refuse to overwrite newer unowned writing.
 */
export function retainedInput(sent: Values, draft: DraftEntry): boolean {
  const recipients = (values: Values) => documentUnits(draftDocument(values)).flatMap(unit => (unit.type === 'taskLabel' || unit.type === 'automationLabel') && context(unit) ? [unit.attrs.id] : []);
  return validSpans(sent, draft) !== null
    && same(recipients(sent), recipients(draft.values))
    && attachmentsOf(sent).every(file => attachmentsOf(draft.values).some(each => same(file, each)))
    && (!sent.uploadOps || sent.uploadOps === draft.values.uploadOps);
}
/** Body retention is not proof that all of the sent message's context is still present.
 * Reconstitute missing owned content from the snapshot, preserving all unowned/newer input.
 * A candidate that conflicts with that input (for example two reply contexts) is not recoverable yet.
 */
export function recoverRetainedInput(sent: Values, draft: DraftEntry): ReturnType<typeof draftDocument> | null {
  const spans = validSpans(sent, draft);
  if (spans === null) return null;
  const raw = documentUnits(draftDocument(draft.values));
  const positions = [...spans].sort((a, b) => a.from - b.from).flatMap(span => Array.from({ length: span.to - span.from }, (_, at) => span.from + at));
  const held = positions.map(at => raw[at]!);
  const insertions = new Map<number, DocumentUnit[]>();
  let at = 0;
  for (const part of diffArrays(documentUnits(draftDocument(sent)), held, { comparator: same })) {
    if (part.added) return null; // A changed body cannot prove the original is still retained.
    if (!part.removed) { at += part.count; continue; }
    // Recipient labels are shared input context, never restored over the person's current recipients.
    // An automation badge comes back over the visible input instead (outbox.ts restore), never shifting another
    // message's held words.
    const missing = part.value.filter(unit => !context(unit) && unit.type !== 'automationLabel');
    const position = positions[at] ?? (positions.at(-1) ?? -1) + 1;
    insertions.set(position, [...insertions.get(position) ?? [], ...missing]);
  }
  const units = raw.flatMap((unit, at) => [...insertions.get(at) ?? [], unit]);
  units.push(...insertions.get(raw.length) ?? []);
  const candidate = documentSchema.safeParse(unitsDocument(units));
  return candidate.success ? candidate.data : null;
}
function withoutFiles(sent: Values, draft: Values): Values {
  const values = { ...draft }, files = attachmentsOf(draft).filter(file => !attachmentsOf(sent).some(each => same(file, each)));
  if (files.length) values.attachments = JSON.stringify(files); else delete values.attachments;
  if (sent.uploadOps === draft.uploadOps) delete values.uploadOps;
  return values;
}
/** Read-only next-send projection from the same body ranges that admission will consume. */
export function projectInput(entries: Entries, input: string, override = entries[input]?.values): Values | undefined {
  const original = entries[input];
  if (!original || !override) return override;
  const draft = { ...original, values: override }, spans = pendingSpans(entries, input, draft);
  let values = override;
  for (const entry of Object.values(entries)) if (bound(entry.values, input, draft) && retainingInput(entry.values)
    && validSpans(entry.values, draft) !== null) values = withoutFiles(entry.values, values);
  return { ...values, doc: JSON.stringify(unitsDocument(documentUnits(draftDocument(values)).filter((_, at) => !spans.some(span => covers(span, at))))) };
}
function saved(entry: DraftEntry, owned: Portion): DraftEntry {
  return { ...entry, values: { ...entry.values, [INPUT_PORTION]: JSON.stringify(owned) } };
}
/** One edit replaces [from,to). Touching the original relinquishes that send's body; outside edits only move it. */
function editedSpans(spans: Span[], from: number, to: number, inserted: number): Span[] {
  if (spans.some(span => from === to ? span.from < from && from < span.to : span.from < to && from < span.to)) return [];
  const delta = inserted - (to - from);
  return spans.map(span => span.from >= to ? { ...span, from: span.from + delta, to: span.to + delta } : span);
}
const boundaries = (units: DocumentUnit[]) => {
  const positions = [1]; // The first paragraph's opening node.
  for (const unit of units) positions.push(positions.at(-1)! + (unit.type === 'paragraphBreak' ? 2 : unit.type === 'text' ? unit.text.length : 1));
  return positions;
};
/** Actual editor steps distinguish deleting the first copy from deleting an identical quote later in the document. */
function editorSpans(spans: Span[], left: DocumentUnit[], right: DocumentUnit[], edit: InputEdit): Span[] {
  if (!same(documentUnits(parseDocument(edit.before.toJSON())), left)) return [];
  const old = boundaries(left), current = boundaries(right), moved: Span[] = [];
  for (const span of spans) {
    let from = old[span.from]!, to = old[span.to]!, touched = false;
    for (const map of edit.mapping.maps) {
      map.forEach((start, end) => {
        if (start === end ? from < start && start < to : from < end && start < to) touched = true;
      });
      from = map.map(from, 1); to = map.map(to, -1);
    }
    const start = current.indexOf(from), end = current.indexOf(to);
    if (touched || start < 0 || end <= start || !same(right.slice(start, end), documentUnits(span.content))) return [];
    moved.push({ ...span, from: start, to: end });
  }
  return moved;
}
/** Every persisted document edit updates ownership atomically with that input, including shared/programmatic edits. */
export function remapInputOwnership(before: Entries, next: Entries, edit?: { input: string; change: InputEdit }): Entries {
  let result = next;
  for (const [input, draft] of Object.entries(next)) {
    const old = before[input];
    if (!old || !draft.values.doc || draft.values.doc === old.values.doc && draft.revision === old.revision) continue;
    const owners = Object.entries(result).filter(([, entry]) => entry.values[INPUT_PORTION] && bound(entry.values, input, draft));
    if (!owners.length) continue;
    const revision = draft.revision !== old.revision && draft.revision ? draft.revision : crypto.randomUUID();
    const left = documentUnits(draftDocument(old.values)), right = documentUnits(draftDocument(draft.values));
    let from = 0, suffix = 0;
    while (from < left.length && from < right.length && same(left[from], right[from])) from++;
    while (suffix < left.length - from && suffix < right.length - from && same(left[left.length - suffix - 1], right[right.length - suffix - 1])) suffix++;
    if (result === next) result = { ...next };
    result[input] = { ...draft, revision };
    for (const [key, entry] of owners) {
      const owned = portion(entry.values)!;
      if (owned.revision === revision) continue; // A known consumption already mapped these ranges exactly.
      const spans = owned.revision !== old.revision ? [] : edit?.input === input
        ? editorSpans(owned.spans, left, right, edit.change)
        : editedSpans(owned.spans, from, left.length - suffix, right.length - from - suffix);
      result[key] = saved(entry, { revision, spans });
    }
  }
  return result;
}
/** Consume the admitted body's known positions and move all sibling portions by those exact deletions. */
export function consumeInput(entries: Entries, entry: DraftEntry): boolean {
  const input = entry.values.from, draft = input ? entries[input] : undefined;
  if (!input || !draft || !bound(entry.values, input, draft)) return false;
  const spans = validSpans(entry.values, draft);
  if (spans === null) return false;
  const doc = unitsDocument(documentUnits(draftDocument(draft.values)).filter((_, at) => !spans.some(span => covers(span, at))));
  let values: Values = { ...withoutFiles(entry.values, draft.values), doc: JSON.stringify(doc) };
  // Prepare the remaining input, never the frozen original: its recipients may have changed while sending.
  if (!hasContent(doc, attachmentsOf(values)) && !values.uploadOps && !replyIn(doc)) values = afterSend(values, doc);
  const revision = crypto.randomUUID();
  for (const [key, sibling] of Object.entries(entries)) if (bound(sibling.values, input, draft) && sibling.values[INPUT_PORTION]) {
    let moved = portion(sibling.values)!.spans;
    for (const span of [...spans].sort((a, b) => b.from - a.from)) moved = editedSpans(moved, span.from, span.to, 0);
    entries[key] = saved(sibling, { revision, spans: moved });
  }
  entries[input] = { ...draft, revision, values };
  return true;
}

/** Map a programmatic change in visible units. Retained originals never participate in this diff. */
function visibleMapping(left: DocumentUnit[], right: DocumentUnit[]) {
  const ranges: number[] = [];
  let at = 0, changed = false;
  for (const part of diffArrays(left, right, { comparator: same })) {
    if (!part.added && !part.removed) { at += part.count; changed = false; continue; }
    if (!changed) { ranges.push(at, 0, 0); changed = true; }
    if (part.added) ranges[ranges.length - 1]! += part.count;
    else { ranges[ranges.length - 2]! += part.count; at += part.count; }
  }
  return new StepMap(ranges);
}
/** All visible edits, with or without an editor, preserve the same hidden originals atomically. */
export function editProjectedInput(entries: Entries, input: string, values: Values, edit?: InputEdit): Entries {
  const draft = entries[input]!, revision = crypto.randomUUID();
  const owners = Object.entries(entries).flatMap(([key, entry]) => {
    if (!bound(entry.values, input, draft) || !retainingInput(entry.values)) return [];
    const spans = validSpans(entry.values, draft);
    return spans === null ? [] : [{ key, entry, spans }];
  });
  if (!owners.length) return { ...entries, [input]: { ...draft, revision, values } };
  const visible = projectInput(entries, input)!, nextDoc = draftDocument(values);
  const left = documentUnits(draftDocument(visible)), right = documentUnits(nextDoc);
  const replacesReply = !!replyIn(nextDoc), replacesAutomation = !!automationIn(nextDoc);
  const all = owners.flatMap(owner => owner.spans), raw = documentUnits(draftDocument(draft.values));
  const oldPositions = boundaries(left), newPositions = boundaries(right);
  if (edit && !same(documentUnits(parseDocument(edit.before.toJSON())), left)) throw new Error('Visible input changed before its edit');
  const mapping = edit ? null : visibleMapping(left, right);
  const move = (at: number) => {
    if (!edit) return mapping!.map(at, -1);
    const position = edit.mapping.map(oldPositions[at]!, -1);
    if (position < 0 || position > newPositions.at(-1)! + 1) throw new Error('Cannot map visible input boundary');
    // Native whole-document replacements can map to 0 or the closing boundary; between paragraphs
    // is also outside an inline unit. Project those gaps to the preceding unit boundary (association -1).
    let from = 0, to = newPositions.length;
    while (from < to) {
      const middle = (from + to) >>> 1;
      if (newPositions[middle]! <= position) from = middle + 1; else to = middle;
    }
    return Math.max(0, from - 1);
  };
  const chunks = owners.flatMap(owner => owner.spans.map(span => {
    const before = raw.slice(0, span.from).filter((_, at) => !all.some(each => covers(each, at))).length;
    // A newer reply or automation badge is visible context. Its predecessor remains in the immutable outgoing snapshot;
    // retain its body here without putting two such labels in the canonical document.
    const units = documentUnits(span.content).filter(unit => !(replacesReply && unit.type === 'replyLabel')
      && !(replacesAutomation && unit.type === 'automationLabel'));
    return { key: owner.key, at: move(before), from: span.from, units };
  })).sort((a, b) => a.at - b.at || a.from - b.from);
  const units: DocumentUnit[] = [], portions = new Map(owners.map(owner => [owner.key, [] as Span[]]));
  let chunk = 0;
  for (let at = 0; at <= right.length; at++) {
    while (chunks[chunk]?.at === at) {
      const current = chunks[chunk++]!, from = units.length;
      units.push(...current.units);
      if (units.length > from) portions.get(current.key)!.push({ from, to: units.length, content: unitsDocument(current.units) });
    }
    if (at < right.length) units.push(right[at]!);
  }
  const hiddenFiles = attachmentsOf(draft.values).filter(file => !attachmentsOf(visible).some(each => same(file, each)));
  const files = [...hiddenFiles, ...attachmentsOf(values).filter(file => !hiddenFiles.some(each => same(file, each)))];
  const next: Values = { ...values, doc: JSON.stringify(unitsDocument(units)) };
  if (files.length) next.attachments = JSON.stringify(files); else delete next.attachments;
  const result = { ...entries, [input]: { ...draft, revision, values: next } };
  for (const owner of owners) result[owner.key] = saved({ ...owner.entry,
    values: { ...owner.entry.values, fresh: next.requestId! } }, { revision, spans: portions.get(owner.key)! });
  return result;
}
