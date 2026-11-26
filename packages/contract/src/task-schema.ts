/**
 * A Task's values: one value per field ID, the fields defined once for the workspace and a project's schema naming
 * which of them its Tasks use, in order. This module is the one Owner of what a field is (`fieldDefSchema`), which
 * fields a workspace has (`fieldCatalog`: the shipped defaults with the stored definitions over them), what a value may
 * be (`schemaOf`, the same zod for checking, the JSON Schema writers read and the screen's form), how a write
 * changes values (`applyValues`) and how values read as text (`renderContext`, what launches and the context tab show).
 */
import { z } from 'zod';
import type { FieldItem, FieldValue, TaskValues } from '@alpacawork/raw';
import type { AnswerPart } from './questions.js';

export const FIELD_TYPES = ['text', 'schema'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const fieldIdSchema = z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/);
/** At most this many fields in a schema and members in a schema-type field; the largest target characters and items. */
export const FIELD_LIMITS = { fields: 32, members: 16, chars: 20_000, items: 200, title: 80, hint: 1000 } as const;

/**
 * One field. A text holds a string; a schema holds an object of its `members` (other fields, the first a text that
 * names the item); `many` makes either a list. `maxChars` and `maxItems` are the sizes a person sets and the writer
 * aims for (null: no size): the field's description says them (`sizeNote`) and a write is refused only past about
 * 30% over them (`hardLimit`), so the writer keeps one number in mind and a little over still saves.
 */
export const fieldDefShape = z.object({
  id: fieldIdSchema,
  title: z.string().trim().min(1).max(FIELD_LIMITS.title),
  type: z.enum(FIELD_TYPES),
  many: z.boolean(),
  maxChars: z.number().int().min(1).max(FIELD_LIMITS.chars).nullable(),
  maxItems: z.number().int().min(1).max(FIELD_LIMITS.items).nullable(),
  /** How to write the value besides its size: the size words are made from maxChars and maxItems. */
  hint: z.string().trim().max(FIELD_LIMITS.hint),
  members: z.array(fieldIdSchema).max(FIELD_LIMITS.members),
  /** Needed by the end: a done report is refused while it has no value (a write of some fields alone never is). */
  required: z.boolean().default(false),
}).strict();
export const fieldDefSchema = fieldDefShape.superRefine((def, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  if (def.type === 'text' && def.members.length) issue('members', 'Only a schema field has members');
  if (def.type === 'schema' && def.maxChars !== null) issue('maxChars', 'A schema field has no maxChars');
  if (def.type === 'schema' && !def.members.length) issue('members', 'A schema field needs members');
  if (new Set(def.members).size !== def.members.length) issue('members', 'Duplicate member');
  if (def.members.includes(def.id)) issue('members', 'A field cannot be its own member');
  if (def.many !== (def.maxItems !== null)) issue('maxItems', def.many ? 'A list needs maxItems' : 'Only a list has maxItems');
});
export type FieldDef = z.infer<typeof fieldDefSchema>;

/** The fields the app reads by ID: always in every schema, never deleted, their IDs and types fixed. */
export const SYSTEM_FIELDS = ['decide', 'user_instructions', 'conclusion', 'notes'] as const;
/** The question's parts: they live inside the question (decide), never on their own in a schema. */
const QUESTION_PARTS = ['decide_question', 'decide_kind', 'decide_choices', 'decide_choice', 'decide_choice_detail', 'decide_choice_recommended',
  'decide_note', 'decide_stop'];
export const isSystemField = (id: string) => (SYSTEM_FIELDS as readonly string[]).includes(id);
/**
 * A project's policy: free text the user writes as they like, carried whole to every launch below the project. No
 * Task's schema names it; it never changes.
 */
export const PROJECT_POLICY = 'project_policy';
/**
 * A project's summary: one sentence on what the project is for. It is listed beside the project's name (`task list`)
 * so that whoever places a request can choose the project without opening it, and it heads the project's policy in
 * every launch below the project.
 */
export const PROJECT_SUMMARY = 'project_summary';
/** The size a summary aims for: the most a write may hold (`hardLimit`) comes to 128 characters. */
const PROJECT_SUMMARY_SIZE = 98;
/** The fields of a project's own values, whatever schema its Tasks use. */
export const PROJECT_SCHEMA: readonly string[] = [PROJECT_SUMMARY, PROJECT_POLICY];
/** Whether a field is a project's own value, which no Task's schema names. */
export const isProjectValue = (id: string) => PROJECT_SCHEMA.includes(id);
/** Whether a project's schema offers to place the field: not a question part, not a project's own value. */
export const isPlaceableField = (id: string) => !isProjectValue(id) && !QUESTION_PARTS.includes(id);

const text = (id: string, title: string, maxChars: number, hint = '', maxItems: number | null = null, required = false): FieldDef =>
  ({ id, title, type: 'text', many: maxItems !== null, maxChars, maxItems, hint, members: [], required });
/**
 * The fields every workspace starts with (shipped). Their definitions are the app's: a workspace sets only whether
 * one is required (`shippedField`). Their sizes are what a writer aims for; the hints leave the size words to `sizeNote`.
 */
export const DEFAULT_FIELDS: readonly FieldDef[] = [
  text('goal', 'Goal', 60, 'One deciding sign that the task is done: what must be in place. Means go in Policy; what not to do goes in Forbidden.'),
  text('policy', 'Policy', 60, 'Key points of how this task is approached. History and reasons go in the notes. Do not copy the project policy.', 5),
  text('forbidden', 'Forbidden', 60, 'What this task alone must not do. Leave out what the project policy already forbids. Write nothing if there is none.', 3),
  text('user_instructions', 'User instructions', 150, 'On the top task, the user’s statements and decisions that still apply, as `<date hh:mm> “original words”` (the user’s local time, 24-hour clock, e.g. `2026-11-11 09:06 “…”`). Fold the same point into its latest one and add how it got there, like “(3 options → B → option 1)”. Quote only the key part of a long statement. Leave out replaced statements, interim options, commands and attachment descriptions (the original stays in History). Goes into the launch prompts of every task below.', 10),
  text('conclusion', 'Conclusion', 120, 'What the parent and the list need to know, in 3 sentences: what was found, what was decided, the recommendation, and whether an answer is awaited. Screen details and numbers go in the notes or deliverables. Do not repeat what a question says.', null, true),
  text('remaining', 'Remaining work', 80, 'One per piece of work left: `<what> — <who / waiting for what>` (the condition to resume). Steps and commands go in files in the task folder. Remove what is done.', 5),
  text('left_running', 'Running processes', 100, 'One per thing running now: what, where, when it stops, and the one command that stops it. Write `none` if there is none. How to restart and clean up goes in files in the task folder.', 3, true),
  text('conditions', 'Done conditions', 100, 'One per condition: `<condition> — met|not met|unchecked (where the evidence is)`. Evidence details and test counts go in the linked file.', 6),
  text('artifact', 'Deliverables', 100, 'One per deliverable: `[name](location) — what it is, revision`. The location is a relative path inside the task folder, an absolute path for code, otherwise a URL or a branch and commit. Put the description of the contents in the linked file. Attach a diff as `![diff](changes.patch)` only when the user decides by reading the wording itself.', 8),
  text('pr', 'PR (MR)', 100, 'Only when a PR (MR) was opened: one URL per PR.', 15),
  { id: 'decide', title: 'Questions', type: 'schema', many: true, required: false, maxChars: null, maxItems: 7,
    members: ['decide_question', 'decide_choices', 'decide_note', 'decide_stop', 'decide_kind'],
    hint: 'Write only when something needs deciding. One question at a time: what to decide, the choices (name and description) and a note. Numbers follow the order. The first word of a choice’s name (up to its first space) becomes its answer button and answer word; do not repeat it within a question, and do not start a name with `stop` or `other`, which the app keeps. The answer arrives as `<number>-<first word of the name>` with any words added; `<number>-other` says none of the choices, with what to do instead. Clear it with null once answered.' },
  text('decide_question', 'What to decide', 60, 'One sentence on what to choose. Background goes in the note.'),
  text('decide_kind', 'Question kind', 6, '`accept` when it asks whether to take a result this task made as it is (merge it, adopt it); `choose` for every other decision (options, permission to publish or deploy, a question without choices). Required when asking.'),
  { id: 'decide_choices', title: 'Choices', type: 'schema', many: true, required: false, maxChars: null, maxItems: 3,
    members: ['decide_choice', 'decide_choice_detail', 'decide_choice_recommended'], hint: '' },
  text('decide_choice', 'Name', 20),
  text('decide_choice_detail', 'Description', 180, 'In 3 lines: what changes if chosen and what is weak. Images as `![subject or action](relative path in the task)`, one per line. Review history and the steps after choosing go in the notes.'),
  text('decide_choice_recommended', 'Recommended', 80, 'Only on the one choice you recommend: why, in one sentence. The screen marks that choice as recommended.'),
  text('decide_note', 'Note', 250, 'Shared assumptions, links to samples and when things stop. Do not repeat the choices’ descriptions or review notes.'),
  text('decide_stop', 'Stop', 180, 'Only when stopping the task is one of the options: what stopping means here, in 3 lines. It is offered as a choice of its own (`<number>-stop`), and whoever picks it stops the task instead of answering. Do not write it as one of the choices.'),
  text(PROJECT_SUMMARY, 'Project summary', PROJECT_SUMMARY_SIZE, 'One sentence on what this project is for: the kind of work that belongs in it. It is listed beside the project’s name, where it is read to choose the project a new request goes under, and it goes above the project policy into the instructions of every piece of work in this project. How the work is done goes in the project policy.'),
  { id: PROJECT_POLICY, title: 'Project policy', type: 'text', many: false, required: false, maxChars: null, maxItems: null, members: [],
    hint: 'What you write here goes as is into the instructions of every piece of work in this project. For example: how you like work done (what may be left to agents and what to ask you about), and what must not be done.' },
  text('notes', 'Notes', 600, 'What the next agent needs to carry on: the decisions in effect and why, one line on how a decision changed (rejected options and why), unchecked points that could change a decision, and the next step and where. Commands, test counts and work steps go in files in the task folder, linked from the deliverables.'),
];
/**
 * The most a write may hold for a size a person set: about 30% over it, rounded up, so even a count of 1 lets one
 * more through and the writer who aims for the size and overshoots a little is not refused.
 */
export const hardLimit = (size: number) => Math.ceil(size * 13 / 10);
/**
 * The size words a field's description starts with, made from its sizes so they never disagree with what a write is
 * checked against: `About 60 characters.`, `About 60 characters each, up to 5 items.` for a list of texts, `Up to 5 items.`
 * for a list of items. A count says `up to` so a field written only when needed (questions, PRs) is not read as a number to reach.
 */
export function sizeNote(def: FieldDef): string {
  const chars = def.type === 'text' ? def.maxChars : null;
  if (!def.many || def.maxItems === null) return chars === null ? '' : `About ${chars} ${chars === 1 ? 'character' : 'characters'}.`;
  const items = `${def.maxItems} ${def.maxItems === 1 ? 'item' : 'items'}`;
  return chars === null ? `Up to ${items}.` : `About ${chars} characters each, up to ${items}.`;
}
/** What a writer is told of a field: the required note when it has one, its size words, then how to write it. */
const howToWrite = (def: FieldDef, ...before: string[]) => [...before, sizeNote(def), def.hint].filter(Boolean).join(' ');
const over = (size: number, unit: string) => `At most ${hardLimit(size)} ${unit} (aim for about ${size})`;
/** The schema of a project that has none of its own and none above it. */
export const DEFAULT_SCHEMA: readonly string[] = ['goal', 'policy', 'forbidden', 'user_instructions', 'conclusion', 'remaining',
  'left_running', 'conditions', 'artifact', 'pr', 'decide', 'notes'];
const SHIPPED: ReadonlyMap<string, FieldDef> = new Map(DEFAULT_FIELDS.map(def => [def.id, def]));
export const isDefaultField = (id: string) => SHIPPED.has(id);
/** What of a shipped field's definition is the app's and never changes: everything but `required`. */
const FIXED_KEYS = ['title', 'type', 'many', 'maxChars', 'maxItems', 'hint', 'members'] as const;
/**
 * A shipped field as the workspace has it: the app's definition with the workspace's `required`. Null when `def`
 * changes any other part of it (the definition is the app's; a field of other wording or sizes is a field of its own).
 */
export function shippedField(def: FieldDef): FieldDef | null {
  const shipped = SHIPPED.get(def.id);
  if (!shipped || FIXED_KEYS.some(key => JSON.stringify(def[key]) !== JSON.stringify(shipped[key]))) return null;
  return withRequired(shipped, def);
}
/** A shipped definition with the one part a workspace sets: `required`, taken from `set`. */
const withRequired = (shipped: FieldDef, set: FieldDef): FieldDef => ({ ...shipped, required: set.required });

export type FieldCatalog = ReadonlyMap<string, FieldDef>;
/**
 * The workspace's fields: the shipped ones, taking only `required` from a stored row of the same ID (a row of older
 * workspaces may hold other words; they are not read), then the stored others.
 */
export function fieldCatalog(stored: readonly FieldDef[]): FieldCatalog {
  const catalog = new Map(SHIPPED);
  for (const def of stored) {
    const shipped = SHIPPED.get(def.id);
    catalog.set(def.id, shipped ? withRequired(shipped, def) : def);
  }
  return catalog;
}

export type FieldProblem = { path: string; message: string };
/** What is wrong with a set of definitions: unknown members, a member list starting with no single text, a cycle. */
export function catalogProblems(catalog: FieldCatalog): FieldProblem[] {
  const problems: FieldProblem[] = [];
  for (const def of catalog.values()) {
    for (const member of def.members.filter(isProjectValue))
      problems.push({ path: `${def.id}.members`, message: `${member} is a project's own value, not a member` });
    for (const member of def.members) if (!catalog.has(member))
      problems.push({ path: `${def.id}.members`, message: `Unknown field ${member}` });
    const first = catalog.get(def.members[0] ?? '');
    if (def.type === 'schema' && first && (first.type !== 'text' || first.many))
      problems.push({ path: `${def.id}.members`, message: 'The first member must be a single text: it names each item' });
  }
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const cyclic = (catalog.get(id)?.members ?? []).some(visit);
    visiting.delete(id); done.add(id);
    return cyclic;
  };
  for (const id of catalog.keys()) if (visit(id)) { problems.push({ path: `${id}.members`, message: 'Members form a cycle' }); break; }
  return problems;
}

/** What is wrong with a schema's field list: unknown or repeated IDs, a missing system field, too many. */
export function schemaProblems(ids: readonly string[], catalog: FieldCatalog): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (ids.length > FIELD_LIMITS.fields) problems.push({ path: 'fields', message: `At most ${FIELD_LIMITS.fields} fields` });
  ids.forEach((id, index) => {
    if (!catalog.has(id)) problems.push({ path: `fields.${index}`, message: `Unknown field ${id}` });
    if (ids.indexOf(id) !== index) problems.push({ path: `fields.${index}`, message: `Duplicate field ${id}` });
    if (isProjectValue(id)) problems.push({ path: `fields.${index}`, message: `${id} is a project's own value, not a Task's field` });
  });
  for (const id of SYSTEM_FIELDS) if (!ids.includes(id))
    problems.push({ path: 'fields', message: `The system field ${id} cannot be left out` });
  return problems;
}

/** A value as stored and read (raw control-document): a text, a list of texts, an item or a list of items. */
export type { FieldItem, FieldValue, TaskValues };

const fieldOf = (catalog: FieldCatalog, id: string): FieldDef => {
  const def = catalog.get(id);
  if (!def) throw new Error(`Unknown field ${id}`);
  return def;
};
/** A schema with a field's title and how to write it, where a reader of the JSON Schema looks for them. */
const described = <Schema extends z.ZodType>(def: FieldDef, schema: Schema): Schema => {
  const description = howToWrite(def);
  return schema.meta({ title: def.title, ...(description ? { description } : {}) });
};
/** A choice's name up to its first space: the word its answer `<n>-<word>` names it by. */
export const choiceWord = (name: string) => name.trim().split(/\s+/)[0]!;
/**
 * The answer words the app keeps for itself: `<n>-stop` picks a question's stop (`decide_stop`) and `<n>-other` says
 * none of its choices. They identify an answer whatever language the screen shows the two under.
 */
export const STOP_WORD = 'stop', OTHER_WORD = 'other';
/**
 * What a question asks (`decide_kind`), said by whoever asks it: `accept`, whether to take a result the asking task made
 * as it is (merge it, adopt it); `choose`, every other decision. Counting how often a result is taken as first made rests on it.
 */
export const QUESTION_KINDS = ['accept', 'choose'] as const;
export type QuestionKind = typeof QUESTION_KINDS[number];
const KEPT_WORDS: Readonly<Record<string, string>> = {
  [STOP_WORD]: 'write the option to stop the task in decide_stop, not as a choice',
  [OTHER_WORD]: 'answering with none of the choices is always offered',
};
/**
 * What a question's choices hold together: each starts its name with a word of its own (an answer names a choice by
 * it, so two starting alike would read as one answer), none starts with a word the app keeps, and at most one is
 * recommended.
 */
function checkChoices(items: unknown[], context: z.RefinementCtx) {
  const first = new Map<string, string>();
  let recommended: string | null = null;
  (items as FieldItem[]).forEach((item, index) => {
    const own = String(item.decide_choice ?? '').trim(), word = choiceWord(own), earlier = first.get(word);
    const issue = (member: string, message: string) => context.addIssue({ code: 'custom', path: [index, member], message });
    const kept = Object.hasOwn(KEPT_WORDS, word.toLowerCase()) ? KEPT_WORDS[word.toLowerCase()] : undefined;
    if (kept) issue('decide_choice', `"${word}" is an answer word the app keeps: ${kept}`);
    else if (word && earlier !== undefined) issue('decide_choice', `"${word}" also starts "${earlier}": an answer names a choice `
      + 'by the word before the first space, so start each choice of a question with a word of its own');
    else if (word) first.set(word, own);
    if (!String(item.decide_choice_recommended ?? '').trim()) return;
    if (recommended !== null) issue('decide_choice_recommended', `Only one choice of a question is recommended; "${recommended}" already is`);
    else recommended = own;
  });
}
function valueShape(def: FieldDef, catalog: FieldCatalog): z.ZodType {
  const one: z.ZodType = def.type === 'text' ? def.maxChars === null ? z.string() : z.string().max(hardLimit(def.maxChars), over(def.maxChars, 'characters'))
    : z.object(Object.fromEntries(def.members.map((id, index) => {
      const member = fieldOf(catalog, id), shape = valueShape(member, catalog);
      return [id, described(member, index === 0 ? (shape as z.ZodString).regex(/\S/, 'Required') : shape.optional())];
    }))).strict();
  if (def.id === 'decide_kind') return z.enum(QUESTION_KINDS);
  if (!def.many) return one;
  const list = z.array(one).max(hardLimit(def.maxItems!), over(def.maxItems!, 'items'));
  return def.id === 'decide_choices' ? list.superRefine(checkChoices) : list;
}
/** One field's value: the one zod the server checks writes with, the JSON Schema says and the screen's form uses. */
export function fieldValueSchema(def: FieldDef, catalog: FieldCatalog): z.ZodType {
  return described(def, valueShape(def, catalog));
}
/**
 * A write's values: only the fields it changes, each a value or null to clear it; any other key is refused. Each
 * field's title and how to write it sit on the field itself, beside its value-or-null choice.
 */
export function schemaOf(ids: readonly string[], catalog: FieldCatalog): z.ZodType<ValuesPatch> {
  return z.object(Object.fromEntries(ids.map(id => {
    const def = fieldOf(catalog, id), field = described(def, valueShape(def, catalog).nullable().optional());
    // A write sends only what it changes, so a required field is not in the JSON Schema's `required`: it is marked on
    // itself, and its description starts by saying so.
    return [id, def.required ? field.meta({ [REQUIRED_MARK]: true, description: howToWrite(def, REQUIRED_NOTE) }) : field];
  }))).strict() as z.ZodType<ValuesPatch>;
}
/** The JSON Schema keyword marking a field a done report needs, and the words its description starts with. */
export const REQUIRED_MARK = 'x-required-at-done';
const REQUIRED_NOTE = 'Required by the final report.';
/** The required fields of a schema that have no value: what keeps a done report from being saved. */
export function missingRequired(ids: readonly string[], values: TaskValues, catalog: FieldCatalog): string[] {
  return ids.filter(id => catalog.get(id)?.required && values[id] === undefined);
}
export type ValuesPatch = { [field: string]: FieldValue | null };
/** What a writer reads before writing: the JSON Schema of a write's values, titles and how to write in descriptions. */
export function valuesJsonSchema(ids: readonly string[], catalog: FieldCatalog): Record<string, unknown> {
  return z.toJSONSchema(schemaOf(ids, catalog), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
}
/** A value with its ends trimmed and empty parts left out; undefined when nothing is left. */
function normalized(def: FieldDef, value: FieldValue, catalog: FieldCatalog): FieldValue | undefined {
  const one = (each: unknown): string | FieldItem | undefined => {
    if (def.type === 'text') { const trimmed = String(each).trim(); return trimmed || undefined; }
    const item: FieldItem = {};
    for (const id of def.members) {
      const member = (each as FieldItem)[id];
      const kept = member === undefined ? undefined : normalized(fieldOf(catalog, id), member, catalog);
      if (kept !== undefined) item[id] = kept;
    }
    return item[def.members[0]!] === undefined ? undefined : item;
  };
  if (!def.many) return one(value);
  const items = (value as unknown[]).map(one).filter(each => each !== undefined);
  return items.length ? items as string[] | FieldItem[] : undefined;
}
/** The values after a checked write: a field it names takes its value, or loses it for null or an empty value. */
export function applyValues(current: TaskValues, patch: ValuesPatch, catalog: FieldCatalog): TaskValues {
  const next: TaskValues = { ...current };
  for (const [id, value] of Object.entries(patch)) {
    const kept = value === null ? undefined : normalized(fieldOf(catalog, id), value, catalog);
    if (kept === undefined) delete next[id]; else next[id] = kept;
  }
  return next;
}
/** The values as one JSON text whatever order they were written in: what versions and unread marks hash. */
export function canonicalValues(values: TaskValues): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
      : value;
  return JSON.stringify(sorted(values));
}

/** Every text in the values, one after another on their own lines: what a search reads and quotes a line of. */
export function valuesText(values: TaskValues): string {
  const texts = (value: FieldValue): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? (value as FieldValue[]).flatMap(texts) : Object.values(value).flatMap(texts);
  return Object.values(values).flatMap(texts).join('\n');
}

/** A text as one list line: its later lines indented under it. */
const listLine = (lead: string, value: string) => `${lead}${value.split('\n').join('\n  ')}`;
/**
 * One item of a schema field at heading `level`: its first member as the heading (numbered when `number` is given, so
 * an answer can name it), the other texts under it, nested items one level down, and a text after
 * nested items set off by a blank line. The first of its text members is its body and reads as written; a later one
 * is led by its title (`Recommended: <why>`), which alone says what it is.
 */
function renderItem(def: FieldDef, item: FieldItem, catalog: FieldCatalog, level: number, number: number | null): string {
  const [head, ...rest] = def.members;
  const lines = [`${'#'.repeat(level)} ${number === null ? '' : `${number} `}${String(item[head!]).replace(/\s*\n\s*/g, ' ')}`];
  const body = rest.find(id => fieldOf(catalog, id).type === 'text');
  let afterItems = false;
  for (const id of rest) {
    const value = item[id], member = fieldOf(catalog, id);
    if (value === undefined) continue;
    if (member.type === 'schema') {
      const items = (member.many ? value : [value]) as FieldItem[];
      lines.push(...items.map(each => renderItem(member, each, catalog, level + 1, null)));
      afterItems = true;
    } else {
      const texts = member.many ? (value as string[]).map(each => listLine('- ', each)) : [String(value)];
      const joined = `${id === body ? '' : `${member.title}:${member.many ? '\n' : ' '}`}${texts.join('\n')}`;
      lines.push(...afterItems ? ['', joined] : [joined]);
    }
  }
  return lines.join('\n');
}
/** A schema field's items as they read under its heading, the questions' full text for `decide`. */
export function renderItems(def: FieldDef, value: FieldValue, catalog: FieldCatalog): string {
  const items = (def.many ? value : [value]) as FieldItem[];
  return items.map((item, index) => renderItem(def, item, catalog, 3, def.many ? index + 1 : null)).join('\n\n');
}
/** One field's value under its heading: a list one `- <item>` line each, a schema its items, a text as written. */
function renderField(def: FieldDef, value: FieldValue, catalog: FieldCatalog): string {
  const body = def.type === 'schema' ? renderItems(def, value, catalog)
    : def.many ? (value as string[]).map(each => listLine('- ', each)).join('\n') : String(value);
  return `## ${def.title}\n${body}`;
}
/**
 * A Task's values as one text, field by field in its schema's order, each a `## <title>` section: a list as `- <item>`
 * lines, a schema as its items (the questions' full text for `decide`), a text as written. Launches and the context
 * tab show this same text.
 */
export function renderContext(ids: readonly string[], values: TaskValues, catalog: FieldCatalog): string {
  return ids.flatMap(id => values[id] === undefined || !catalog.has(id) ? [] : [renderField(catalog.get(id)!, values[id]!, catalog)])
    .join('\n\n');
}

/**
 * A question's full text as an agent reads it: the `decide` items it was asked with (fixed in its asking record), by
 * the shipped definitions, which a workspace never changes.
 */
export const questionText = (decide: readonly FieldItem[]): string => renderItems(SHIPPED.get('decide')!, decide as FieldItem[], SHIPPED);

/** A write's values as sent: field ID to value or null; each value is checked by the server against the Task's schema. */
export const valuesInputSchema = z.record(fieldIdSchema, z.unknown());

/**
 * field get: the fields a Task uses (`fields`, from project `from`, null for the default schema) and the JSON Schema
 * of a write's values (`schemaOf`); `schema` is null when the caller already holds `version`.
 */
export const fieldGetResultSchema = z.object({
  task: z.string().nullable(), from: z.string().nullable(), fields: z.array(fieldIdSchema),
  version: z.string(), schema: z.record(z.string(), z.unknown()).nullable(),
}).strict();
/** One field as field list shows it: its definition and what it is to the app and the workspace. */
export const fieldViewSchema = fieldDefShape.extend({
  /** In every schema, never deleted (SYSTEM_FIELDS). */ system: z.boolean(),
  /** Shipped with the app (DEFAULT_FIELDS): only `required` changes; `stored` when the workspace set it or added it. */
  default: z.boolean(), stored: z.boolean(),
  /** Projects whose own schema names it and fields it is a member of; whether the default schema names it. */
  use: z.object({ projects: z.array(z.string()), fields: z.array(fieldIdSchema), defaultSchema: z.boolean() }).strict(),
}).strict();
export const fieldListResultSchema = z.object({ fields: z.array(fieldViewSchema) }).strict();
export const fieldSetResultSchema = z.object({ field: fieldViewSchema }).strict();
/** field delete: the field and how many stored values went with it. */
export const fieldDeleteResultSchema = z.object({ field: fieldIdSchema, values: z.number().int().nonnegative() }).strict();
/**
 * What a Task read carries of its values (task get, the screen's task view): the values, the fields its schema uses
 * and where that schema comes from, and `context`, those values as renderContext writes them (what a launch carries).
 */
export const taskValuesViewSchema = z.object({ values: z.record(fieldIdSchema, z.unknown()), fields: z.array(fieldIdSchema),
  from: z.string().nullable(), context: z.string() }).strict();

/**
 * task values: a Task's values as they were at `at` (each later write undone from the versions kept when it replaced a
 * value). `values` is null with `reason` when they are not known then: `not-created` before the Task existed,
 * `not-recorded` before versions began to be kept. `recordedSince` is the earliest time they are known for this Task.
 */
export const taskValuesAtSchema = z.object({ task: z.string(), at: z.string(), values: z.record(fieldIdSchema, z.unknown()).nullable(),
  reason: z.enum(['not-created', 'not-recorded']).optional(), recordedSince: z.string() }).strict();
export type TaskValuesAt = z.infer<typeof taskValuesAtSchema>;

/**
 * The one reading of an answer's words against the question as it was asked (its `decide` items). Items are named by
 * `<n>-<word>` labels that lead a line (after a task mark `T3（…）` or `T3` there, as the screen writes it), one after
 * another; the first words after them end the labels of that line. Its word is the first word of one of its choices
 * (as written, or without its closing punctuation), `other` or `stop`. A label naming no choice, and an item no label
 * names, are `unmatched`; an item's `words` says whether words follow its labels' line, or the lines after it until the
 * next labels. Labels inside the words (a quote, a mention) are words.
 */
export function readAnswerParts(decide: readonly FieldItem[], text: string): { items: AnswerPart[]; words: boolean } {
  const labels = new Map<number, { word: string; words: boolean }>();
  let last: { word: string; words: boolean } | null = null, rest = false;
  for (const line of text.split(/\r?\n/)) {
    let at = line.replace(/^\s*(?:T\d+(?:（[^\n]*?）)?\s+)?/, '');
    const named: { word: string; words: boolean }[] = [];
    for (let found = /^([1-9]\d{0,2})-(\S+)(?:\s+|$)/.exec(at); found; found = /^([1-9]\d{0,2})-(\S+)(?:\s+|$)/.exec(at)) {
      at = at.slice(found[0].length);
      const label = labels.get(Number(found[1])) ?? { word: found[2]!, words: false };
      labels.set(Number(found[1]), label); named.push(label);
    }
    const said = /\S/.test(at);
    if (named.length) last = named.at(-1)!;
    if (said && last) last.words = true;
    if (said) rest = true;
  }
  const word = (choices: FieldItem[], said: string) => {
    const index = choices.findIndex(each => choiceWord(String(each.decide_choice ?? '')) === said);
    if (index !== -1) return index;
    const bare = said.replace(/[。．.、,，!！?？)）]+$/, '');
    return bare === said ? -1 : choices.findIndex(each => choiceWord(String(each.decide_choice ?? '')) === bare);
  };
  const items = decide.map((item, index): AnswerPart => {
    const n = index + 1, label = labels.get(n);
    if (label === undefined) return { n, kind: 'unmatched', words: false };
    const said = label.word.replace(/[。．.、,，!！?？)）]+$/, '').toLowerCase(), words = label.words;
    const choices = Array.isArray(item.decide_choices) ? item.decide_choices as FieldItem[] : [];
    // A choice's own word (`stop!` is a choice's) comes before the words the app keeps.
    const exact = choices.findIndex(each => choiceWord(String(each.decide_choice ?? '')) === label.word);
    if (exact === -1 && said === OTHER_WORD) return { n, kind: 'other', words };
    if (exact === -1 && said === STOP_WORD) return { n, kind: 'stop', words };
    const choice = exact !== -1 ? exact : word(choices, label.word);
    return choice === -1 ? { n, kind: 'unmatched', words }
      : { n, kind: 'choice', choice: choice + 1, recommended: !!String(choices[choice]!.decide_choice_recommended ?? '').trim(), words };
  });
  return { items, words: rest };
}
