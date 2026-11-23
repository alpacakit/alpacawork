/** The editor document owns its recipients (Task labels) and answer selections. Wire text is a projection. */
import { formatTask, taskTokens } from './wire';
import { z } from 'zod';
import { parseTaskId, taskIdSchema } from '@alpacawork/contract';
import { coordinatorAnswersInputSchema, type CoordinatorAnswers } from '@alpacawork/contract/coordinator';
import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Mapping } from '@tiptap/pm/transform';
import { resolveReference } from '@/domain/tasks';
import type { Task, TaskDetail } from '@/data/types';
import { isOtherAnswer, type Choice, type Question } from '@/domain/questions';
import { skillAttrs } from '@/data/skill-catalog';
export { skillAttrs, type Skill } from '@/data/skill-catalog';

const taskAttrs = z.object({ id: taskIdSchema, title: z.string() });
/** An answer names the question it answers (its asking record): what it asks is fixed there. */
const answerAttrs = z.object({ ...coordinatorAnswersInputSchema.element.shape, n: z.string(), name: z.string(), answer: z.string() });
const replyAttrs = z.object({ id: z.string().min(1).max(256), answeredAt: z.string() });
export const READER_OPERATION_MARK = 'readerOperation';
const inline = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1), marks: z.array(z.object({type:z.literal(READER_OPERATION_MARK)})).optional() }),
  z.object({ type: z.literal('hardBreak') }),
  z.object({ type: z.literal('taskLabel'), attrs: taskAttrs }),
  z.object({ type: z.literal('answerLabel'), attrs: answerAttrs }),
  z.object({ type: z.literal('skillLabel'), attrs: skillAttrs }),
  z.object({ type: z.literal('replyLabel'), attrs: replyAttrs }),
]);
export const documentSchema = z.object({ type: z.literal('doc'), content: z.array(z.object({ type: z.literal('paragraph'), content: z.array(inline).optional() })).min(1) }).refine(doc => {
  let foundReply = false;
  for (const block of doc.content) {
    if (!block.content) continue;
    for (const node of block.content) {
      if (node.type !== 'replyLabel') continue;
      if (foundReply) return false;
      foundReply = true;
    }
  }
  return true;
}, 'Only one reply label is allowed');
export type Document = z.infer<typeof documentSchema>;
export type Inline = z.infer<typeof inline>;
export type Answer = z.infer<typeof answerAttrs>;
export const emptyDocument = (): Document => ({ type: 'doc', content: [{ type: 'paragraph' }] });
export function textDocument(text: string): Document {
  return { type: 'doc', content: text.split('\n').map(line => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text' as const, text: line }] } : {}) })) };
}
/** A coordinator draft's words: its `doc` alone (draft-store requires it of every coordinator entry). */
export const draftDocument = (values: Record<string, string>): Document => documentSchema.parse(JSON.parse(values.doc ?? ''));
/** What a coordinator draft holds to send, as one value to compare: its words, labels and answers, and its files. */
export const writtenIn = (values: Record<string, string>) => `${values.doc ?? ''}\n${values.attachments ?? ''}`;
export const parseDocument = (doc: JSONContent): Document => documentSchema.parse(doc);
export const taskLabel = (task: Pick<Task, 'id' | 'title'>): Inline => ({ type: 'taskLabel', attrs: { id: task.id, title: task.title } });
export const inlines = (doc: Document) => doc.content.flatMap(block => block.content ?? []);
/** Structural positions: labels and hard breaks are atoms; paragraph boundaries are distinct from hard breaks. */
export type DocumentUnit = Inline | { type: 'paragraphBreak' };
export const documentUnits = (doc: Document): DocumentUnit[] => doc.content.flatMap((block, index) => [
  ...index ? [{ type: 'paragraphBreak' as const }] : [],
  ...(block.content ?? []).flatMap<Inline>(node => node.type === 'text' ? Array.from(node.text, text => ({ ...node, text })) : [node]),
]);
export function unitsDocument(units: readonly DocumentUnit[]): Document {
  const result = emptyDocument();
  for (const node of units) {
    if (node.type === 'paragraphBreak') { result.content.push({ type: 'paragraph' }); continue; }
    const block = result.content.at(-1)!;
    block.content ??= [];
    const previous = block.content.at(-1);
    if (node.type === 'text' && previous?.type === 'text' && JSON.stringify(node.marks) === JSON.stringify(previous.marks)) previous.text += node.text;
    else block.content.push({ ...node });
  }
  return result;
}
/**
 * The Tasks a draft is for: its labels, its answers' Tasks and the Task IDs written in its words. The words are read as
 * the whole text, paragraph by paragraph, with each label or answer an opaque mark in its place, so a quote, a code
 * fence or a URL spans the lines it spans; a label at a line's start is not that line's quote marker. Label payloads and
 * answer names are never rescanned.
 */
export function taskReferencesIn(doc: Document, tasks: readonly Task[]) {
  let index: { byId: Map<string, Task> } | undefined;
  const lookup = (id: string) => resolveReference(id, index ??= { byId: new Map(tasks.map(task => [task.id, task])) });
  const references = new Set<string>();
  const text = doc.content.map(block => (block.content ?? []).map(node => {
    if (node.type === 'text') return node.text;
    if (node.type === 'hardBreak') return '\n';
    const id = node.type === 'taskLabel' ? node.attrs.id : node.type === 'answerLabel' ? node.attrs.task : null;
    // A formal label is already a chosen recipient; prose references use the same ID-format rule.
    if (id) references.add(id);
    return '\uFFFC';
  }).join('')).join('\n');
  for (const token of taskTokens(text, lookup)) references.add(token.id);
  return references;
}
export function answersIn(doc: Document, task?: string): Answer[] {
  const answers: Answer[] = [];
  for (const block of doc.content) {
    for (const node of block.content ?? []) {
      if (node.type === 'answerLabel' && (!task || node.attrs.task === task)) answers.push(node.attrs);
    }
  }
  return answers;
}
/** The person's own words: text that is not blank, or a skill. */
const isWords = (type: string, text?: string) => type === 'text' ? !!text?.trim() : type === 'skillLabel';
/** Content shared by retained JSON and live editor nodes; recipient/reply labels and breaks are empty. */
export const hasInlineContent = (type: string, text?: string) => isWords(type, text) || type === 'answerLabel';
/** Something to send besides its recipients: words, an answer, a skill or attachments. Task labels alone say nothing. */
export const hasContent = (doc: Document, attachments: readonly unknown[] = []) => attachments.length > 0 || doc.content.some(block => block.content?.some(node => hasInlineContent(node.type, node.type === 'text' ? node.text : undefined)));
export function filterDocument(doc: Document, keep: (node: Inline) => boolean): Document {
  return { type: 'doc', content: doc.content.map(block => ({ ...block, content: (block.content ?? []).filter(keep) })) };
}
/**
 * The same question's answer: a choice is one question's (task, question ID and number), so another of the same number
 * of the same question takes its place, and the same number of another question is another answer.
 */
export const sameQuestion = (one: Pick<Answer, 'question' | 'n'>, other: Pick<Answer, 'question' | 'n'>) => one.question === other.question && one.n === other.n;
export const sameAnswer = (one: Pick<Answer, 'task' | 'question' | 'n'>, other: Pick<Answer, 'task' | 'question' | 'n'>) => one.task === other.task && sameQuestion(one, other);
/**
 * Whether the person wrote something after an answer's chip, before the next chip or task: the words that go with it.
 * Other says nothing without them.
 */
export function wordsAfter(doc: Document, answer: Pick<Answer, 'task' | 'question' | 'n'>): boolean {
  let found = false;
  for (const block of doc.content) {
    for (const node of block.content ?? []) {
      if (!found) {
        found = node.type === 'answerLabel' && sameAnswer(node.attrs, answer);
        continue;
      }
      if (node.type === 'answerLabel' || node.type === 'taskLabel') return false;
      if (isWords(node.type, node.type === 'text' ? node.text : undefined)) return true;
    }
  }
  return false;
}
/**
 * Whether the person wrote words of their own for `task`: after its label or one of its answers, before another task's
 * label or answer (an answer names its task, as a label does).
 */
export function saysFor(doc: Document, task: string): boolean {
  let at: string | null = null;
  for (const block of doc.content) {
    for (const node of block.content ?? []) {
      if (node.type === 'taskLabel') at = node.attrs.id;
      else if (node.type === 'answerLabel') at = node.attrs.task;
      else if (at === task && isWords(node.type, node.type === 'text' ? node.text : undefined)) return true;
    }
  }
  return false;
}
/** The task's answers that answer: each choice, and Other with words after it. */
export const givenIn = (doc: Document, task: string) => answersIn(doc, task).filter(answer => !isOtherAnswer(answer) || wordsAfter(doc, answer));
/**
 * Puts in or takes back one question's answer, replacing that question's other answer. A choice goes in order after
 * its task, before any Other; Other goes at the draft's end, where the caret is put to write what instead, so the
 * words written after it stay its own whatever is chosen later.
 */
export function toggleAnswer(doc: Document, task: Pick<Task, 'id' | 'title'>, answer: Answer): Document {
  const same = answersIn(doc, task.id).find(item => sameQuestion(item, answer));
  const next = filterDocument(doc, node => node.type !== 'answerLabel' || node.attrs.task !== task.id || !sameQuestion(node.attrs, answer));
  if (same?.answer === answer.answer) return next;
  let block = next.content.find(block => block.content?.some(node => node.type === 'taskLabel' && node.attrs.id === task.id));
  if (!block) { block = next.content[0]!; block.content = [taskLabel(task), ...(block.content ?? [])]; }
  if (isOtherAnswer(answer)) {
    const last = next.content.at(-1)!;
    last.content = [...(last.content ?? []), { type: 'answerLabel', attrs: answer }];
    return next;
  }
  const content = block.content!;
  const taskAt = content.findIndex(node => node.type === 'taskLabel' && node.attrs.id === task.id);
  // After the Task's label, each question's answers stay together, in their numbers' order, before any Other.
  const answerOfTask = (node: Inline) => node.type === 'answerLabel' && node.attrs.task === task.id && !isOtherAnswer(node.attrs);
  let end = taskAt + 1;
  while (end < content.length && answerOfTask(content[end]!)) end++;
  const own = content.slice(taskAt + 1, end).flatMap((node, offset) =>
    node.type === 'answerLabel' && node.attrs.question === answer.question ? [{ at: taskAt + 1 + offset, n: node.attrs.n }] : []);
  const at = own.find(item => Number(item.n) > Number(answer.n))?.at ?? (own.length ? own.at(-1)!.at + 1 : end);
  content.splice(at, 0, { type: 'answerLabel', attrs: answer });
  return next;
}
/**
 * The fixed question references attached to draft choices, in document order. These preserve the original question identity;
 * the receiving coordinator decides from the words whether saving an answer is appropriate.
 */
export function answeredQuestions(doc: Document): { answers?: CoordinatorAnswers } {
  const asked = [...new Map(answersIn(doc).map(answer => {
    const reference = { task: answer.task, question: answer.question };
    return [JSON.stringify(reference), reference] as const;
  })).values()];
  return asked.length ? { answers: asked } : {};
}
/** `asked` is the question's ID (its asking record); `question` is one of the questions it asks. */
export const choiceAnswer = (task: Pick<TaskDetail, 'id' | 'hash' | 'responsibleRevision'>, asked: string, question: Question, choice: Choice): Answer => ({
  question: asked, task: task.id,
  n: question.n, name: choice.name, answer: choice.answer });
/**
 * The words a message carries. A skill is called by `mark`: the catalog of the agent the message goes to, when it says
 * (skillMark); else the mark the chip was chosen with.
 */
export function serialize(doc: Document, mark: (name: string) => '/' | '$' | undefined = () => undefined): string {
  return doc.content.map(block => {
    let text = '', task: string | null = null;
    const badge = (label: string) => { if (text && !/\s$/.test(text)) text += ' '; text += label + ' '; };
    for (const node of block.content ?? []) {
      if (node.type === 'text') { text += node.text; if (node.text.trim()) task = null; }
      else if (node.type === 'hardBreak') { text += '\n'; task = null; }
      else if (node.type === 'taskLabel') { badge(formatTask(node.attrs.id, node.attrs.title)); task = node.attrs.id; }
      else if (node.type === 'answerLabel') { badge(`${task === node.attrs.task ? '' : node.attrs.task + ' '}${node.attrs.answer}`); task = node.attrs.task; }
      else if (node.type === 'skillLabel') { badge(`${mark(node.attrs.name) ?? node.attrs.invocation}${node.attrs.name}`); task = null; }
    }
    return text.trimEnd();
  }).join('\n').trim();
}

export type Reply = z.infer<typeof replyAttrs>;
export function replyIn(doc: Document): Reply | undefined {
  for (const block of doc.content) {
    for (const node of block.content ?? []) {
      if (node.type === 'replyLabel') return node.attrs;
    }
  }
}
/** A Task's label, not a project's: a reply takes these off. */
const isTaskLabel = (node: Inline) => node.type === 'taskLabel' && parseTaskId(node.attrs.id)?.kind === 'task';
/**
 * The one way a reply goes into a draft (the reply icon): it takes the place of any other reply, and the draft's Task
 * labels come off, so the message is about that answer rather than a Task. Project labels, answers, skills, words
 * (Task IDs written in them included) stay. A press that changes nothing returns the same document (caret, undo history).
 */
export function replyTo(doc: Document, reply: Reply): Document {
  if (replyIn(doc)?.id === reply.id && !inlines(doc).some(isTaskLabel)) return doc;
  const next = filterDocument(doc, node => node.type !== 'replyLabel' && !isTaskLabel(node));
  next.content[0]!.content = [{ type: 'replyLabel', attrs: replyAttrs.parse(reply) }, ...(next.content[0]!.content ?? [])];
  return documentSchema.parse(next);
}

/** The fixed operation's source stays part of the one editable document, so context/label changes move it coherently. */
export const hasReaderOperation = (doc: Document) => doc.content.some(block => block.content?.some(node => node.type === 'text' && node.marks?.some(mark => mark.type === READER_OPERATION_MARK)));
export function markReaderOperation(doc: Document): Document {
  if (hasReaderOperation(doc)) return doc;
  return {...doc, content:doc.content.map((block,at)=>at ? block : {...block,content:block.content?.map(node=>node.type==='text'
    ? {...node,marks:[{type:READER_OPERATION_MARK}]} : node)})};
}
/** Editing any original operation word ends that operation; inserting outside its source merely adds commentary. */
export function afterReaderOperationEdit(doc: Document, before: ProseMirrorNode, mapping: Mapping): Document {
  const spans: [number,number][]=[];
  before.descendants((node,pos)=>{if(node.isText && node.marks.some(mark=>mark.type.name===READER_OPERATION_MARK))spans.push([pos,pos+node.nodeSize]);});
  const touched=spans.some(([from,to])=>{
    for(const map of mapping.maps){
      let changed=false;
      map.forEach((start,end)=>{if(start<to && end>from || start===end && start>from && start<to)changed=true;});
      if(changed)return true;
      from=map.map(from,1);to=map.map(to,-1);
    }
    return false;
  });
  return !touched ? doc : {...doc,content:doc.content.map(block=>({...block,content:block.content?.map(node=>{
    if(node.type!=='text')return node;
    const {marks:_operation,...text}=node;return text;
  })}))};
}
