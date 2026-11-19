/**
 * The one-time move of Task bodies into Task values (control migration task-values-v1, run by stopped maintenance
 * inside the standard migrator's transaction). A task's body is read once by the rules the default extracts had when
 * bodies were last written (frozen here: those rules leave the app with this migration); a project's body is its
 * policy, moved whole as written (contract PROJECT_POLICY). The values go to
 * task_values; the bodies and project settings it reads are kept as migration evidence until the next packaged
 * migration (drop_task_values_evidence) removes them in the same migrator run. `planTaskValues` is the dry
 * run (counts and lists, nothing written) that inspect shows; `applyTaskValuesMigration` writes the same plan.
 */
import type { DatabaseSync } from 'node:sqlite';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { packagedMigrations, writeMigrationEvidence } from '@alpacawork/db';
import { DEFAULT_SCHEMA, PROJECT_POLICY, fieldCatalog, schemaOf, type FieldItem, type FieldValue, type TaskValues } from '@alpacawork/contract';

export const TASK_VALUES_MIGRATION = 'task-values-v1';
export const TASK_VALUES_SQL = '20261108000000_task_values';

/** The one-line items of the default extracts at their last release: `- <title>: <value>` lines, by field ID. */
const OLD_LINE_ITEMS: readonly (readonly [string, string])[] = [
  ['goal', 'ゴール'], ['policy', '方針'], ['forbidden', '禁止事項'], ['user_instructions', 'ユーザーの指示文'],
  ['conclusion', '結論'], ['remaining', '残件'], ['left_running', '動かしたままのもの'], ['conditions', '完了条件'],
  ['artifact', '成果物'], ['pr', 'PR（MR）'],
];
/** An item the default extracts no longer had: its lines are dropped, kept only in the evidence. */
const RETIRED_LINE = /^- 進み具合: ([^\r\n]+)$/;
/** Their sections: the questions until the next `## ` line, and the notes to the end of the body. */
const OLD_DECIDE = '上に決めてほしいこと', OLD_NOTES = '本文';
/** Fields that hold one value: lines of these beyond the first are joined to it. */
const SINGLE = new Set(['goal', 'conclusion']);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ITEM_LINE = OLD_LINE_ITEMS.map(([id, title]) => ({ id, pattern: new RegExp(`^- ${escape(title)}: ([^\\r\\n]+)$`) }));
const sectionHeading = (title: string) => new RegExp(`^## ${escape(title)}[ \\t]*$`);
const HEADING = /^#{1,6}\s/;

/** What reading one body found besides the values: what moved to notes, what was dropped, what was joined. */
export type BodyReading = {
  values: TaskValues;
  /** Lines outside every item and section, now at the top of the notes. */
  movedToNotes: number;
  /** Lines of the retired progress item (RETIRED_LINE), dropped. */
  droppedRetired: number;
  /** Heading lines with nothing of their own under them, dropped. */
  droppedHeadings: string[];
  /** Single fields that had several lines, joined with line breaks. */
  joined: string[];
  /** The questions' section could not be read as questions and moved to the notes as written. */
  decideToNotes: boolean;
};

type ParsedQuestion = { ask: string; intro: string[]; choices: { name: string; text: string[] }[]; after: string[] };
const QUESTION = /^###\s+(\S+)\s+(.+?)\s*$/, CHOICE = /^####\s+(.+?)\s*$/;
/**
 * The questions' section read as the question cards read it (web domain/questions decideOf): `### <n> <question>`,
 * `#### <name>` choices with the lines under them until a blank line, then the shared text. Text before the first
 * question is returned apart.
 */
function readQuestions(text: string): { before: string; questions: ParsedQuestion[] } {
  const before: string[] = [], questions: ParsedQuestion[] = [], lines = text.split('\n');
  let into: 'before' | 'intro' | 'choice' | 'after' = 'before', fence = false, closed = false;
  for (const [at, line] of lines.entries()) {
    const question = questions.at(-1), choice = question?.choices.at(-1), fenceLine = line.startsWith('```');
    if (!fence && question && /^##(?:\s|$)/.test(line)) { closed = true; into = 'after'; }
    if (!closed && !fence && QUESTION.test(line)) {
      questions.push({ ask: QUESTION.exec(line)![2]!, intro: [], choices: [], after: [] }); into = 'intro'; continue;
    }
    if (!closed && !fence && question && into !== 'after' && CHOICE.test(line)) {
      question.choices.push({ name: CHOICE.exec(line)![1]!, text: [] }); into = 'choice'; continue;
    }
    if (fenceLine) fence = !fence;
    if (into === 'choice' && choice) {
      if (!fence && !fenceLine && !line.trim()) {
        let next = at + 1;
        while (next < lines.length && !lines[next]!.trim()) next++;
        if (choice.text.length && !CHOICE.test(lines[next] ?? '')) into = 'after';
        continue;
      }
      choice.text.push(line); continue;
    }
    (into === 'before' ? before : into === 'intro' ? question!.intro : question!.after).push(line);
  }
  return { before: before.join('\n').trim(), questions };
}
const joinText = (lines: readonly string[]) => lines.join('\n').trim();
/** The questions as decide items; the intro of a question goes before its shared text. */
function decideItems(questions: readonly ParsedQuestion[]): FieldItem[] {
  return questions.map(question => {
    const item: FieldItem = { decide_question: question.ask };
    const choices = question.choices.map(choice => {
      const detail = joinText(choice.text);
      return { decide_choice: choice.name, ...detail ? { decide_choice_detail: detail } : {} };
    });
    if (choices.length) item.decide_choices = choices;
    const note = [joinText(question.intro), joinText(question.after)].filter(Boolean).join('\n\n');
    if (note) item.decide_note = note;
    return item;
  });
}

/** One body read by the frozen rules into values (see the module comment); nothing in it is lost but blank lines and empty headings. */
export function readBody(body: string): BodyReading {
  const lines = body.split('\n'), rows = new Map<string, string[]>(), itemLines = new Set<number>();
  lines.forEach((line, index) => {
    for (const { id, pattern } of ITEM_LINE) {
      const match = pattern.exec(line);
      if (!match) continue;
      itemLines.add(index);
      const value = match[1]!.trim();
      if (value) rows.set(id, [...rows.get(id) ?? [], value]);
    }
  });
  const decideAt = lines.findIndex((line, index) => sectionHeading(OLD_DECIDE).test(line) && index < lines.length - 1);
  let decideEnd = lines.length;
  if (decideAt >= 0) for (let index = decideAt + 2; index < lines.length; index++) if (lines[index]!.startsWith('## ')) { decideEnd = index; break; }
  const inDecide = (index: number) => decideAt >= 0 && index >= decideAt && index < decideEnd;
  const notesAt = lines.findIndex((line, index) => sectionHeading(OLD_NOTES).test(line) && index < lines.length - 1);
  const notes = notesAt < 0 ? '' : joinText(lines.slice(notesAt + 1).filter((_, offset) => !inDecide(notesAt + 1 + offset)));

  // What is outside every item and section, in order; a heading with nothing of its own under it is only layout.
  let droppedRetired = 0;
  const outside = lines.flatMap((line, index) => {
    if ((notesAt >= 0 && index >= notesAt) || inDecide(index) || itemLines.has(index) || !line.trim()) return [];
    if (RETIRED_LINE.test(line)) { droppedRetired++; return []; }
    return [line];
  });
  const droppedHeadings: string[] = [], kept: string[] = [];
  outside.forEach((line, index) => {
    if (HEADING.test(line) && (index === outside.length - 1 || HEADING.test(outside[index + 1]!))) droppedHeadings.push(line);
    else kept.push(line);
  });

  const values: TaskValues = {}, joined: string[] = [];
  for (const [id] of OLD_LINE_ITEMS) {
    const found = rows.get(id);
    if (!found) continue;
    if (SINGLE.has(id)) { values[id] = found.join('\n'); if (found.length > 1) joined.push(id); }
    else values[id] = found;
  }
  const leading: string[] = [];
  let decideToNotes = false;
  if (decideAt >= 0) {
    const text = joinText(lines.slice(decideAt + 1, decideEnd));
    const { before, questions } = text ? readQuestions(text) : { before: '', questions: [] };
    if (questions.length) {
      values.decide = decideItems(questions);
      if (before) leading.push(`### ${OLD_DECIDE}\n${before}`);
    } else if (text) { leading.push(`### ${OLD_DECIDE}\n${text}`); decideToNotes = true; }
  }
  if (kept.length) leading.unshift(kept.join('\n'));
  const note = [...leading, notes].filter(Boolean).join('\n\n');
  if (note) values.notes = note;
  return { values, movedToNotes: kept.length, droppedRetired, droppedHeadings, joined, decideToNotes };
}

/** The dry run: what the migration would write and everything it would move, join, drop or refuse, by Task. */
export type TaskValuesPlan = {
  tasks: number; tasksWithValues: number; rows: number;
  /** Projects whose body moved whole to their policy. */
  projectPolicies: string[];
  movedToNotes: { task: string; lines: number }[];
  /** Lines of the retired progress item dropped, by Task. */
  droppedRetired: { task: string; lines: number }[];
  droppedHeadings: { task: string; lines: string[] }[];
  joined: { task: string; fields: string[] }[];
  decideToNotes: string[];
  /** Values over a field's limit (kept as they are; the next write of that field is checked). */
  overLimit: { task: string; path: string; message: string }[];
  /** Projects with their own extracts: the migration stops until a person removes them. */
  blocked: { project: string; reason: string }[];
};
type SourceRow = { rowid: number; id: string; external: string; kind: string; body: string; settings: string | null };
const sourceRows = (db: DatabaseSync): SourceRow[] => db.prepare('SELECT rowid,id,external_id,kind,body,settings FROM tasks ORDER BY number').all()
  .map(row => ({ rowid: Number(row.rowid), id: String(row.id), external: String(row.external_id), kind: String(row.kind),
    body: String(row.body), settings: row.settings === null ? null : String(row.settings) }));

function plan(db: DatabaseSync): { plan: TaskValuesPlan; values: Map<string, TaskValues>; rows: SourceRow[] } {
  const rows = sourceRows(db), check = schemaOf(DEFAULT_SCHEMA, fieldCatalog([])), values = new Map<string, TaskValues>();
  const result: TaskValuesPlan = { tasks: rows.length, tasksWithValues: 0, rows: 0, projectPolicies: [], movedToNotes: [], droppedRetired: [], droppedHeadings: [],
    joined: [], decideToNotes: [], overLimit: [], blocked: [] };
  for (const row of rows) {
    if (row.settings !== null && Object.hasOwn(JSON.parse(row.settings) as object, 'extracts'))
      result.blocked.push({ project: row.external, reason: 'The project has its own extracts; remove them (task update --extracts null) with the previous release, then migrate' });
    if (row.kind === 'project') {
      const policy = row.body.trim();
      if (!policy) continue;
      values.set(row.id, { [PROJECT_POLICY]: policy });
      result.tasksWithValues++; result.rows++; result.projectPolicies.push(row.external);
      continue;
    }
    const reading = readBody(row.body), count = Object.keys(reading.values).length;
    if (!count) continue;
    values.set(row.id, reading.values);
    result.tasksWithValues++; result.rows += count;
    if (reading.movedToNotes) result.movedToNotes.push({ task: row.external, lines: reading.movedToNotes });
    if (reading.droppedRetired) result.droppedRetired.push({ task: row.external, lines: reading.droppedRetired });
    if (reading.droppedHeadings.length) result.droppedHeadings.push({ task: row.external, lines: reading.droppedHeadings });
    if (reading.joined.length) result.joined.push({ task: row.external, fields: reading.joined });
    if (reading.decideToNotes) result.decideToNotes.push(row.external);
    const checked = check.safeParse(reading.values);
    if (!checked.success) for (const issue of checked.error.issues)
      result.overLimit.push({ task: row.external, path: issue.path.map(String).join('.'), message: issue.message });
  }
  return { plan: result, values, rows };
}
/** The dry run on a database still holding bodies (the migration pending); null once bodies are gone. */
export function planTaskValues(db: DatabaseSync): TaskValuesPlan | null {
  const hasBody = db.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name='body'").get();
  const hasValues = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_values'").get();
  if (!hasBody) return null;
  if (hasValues && db.prepare('SELECT 1 FROM task_values LIMIT 1').get()) return null;
  return plan(db).plan;
}

/** The refusal when projects hold their own extracts: it names them, and the database stays as it was. */
export function migrationBlocked(blocked: TaskValuesPlan['blocked']): Problem {
  const projects = blocked.map(each => each.project).join(', ');
  return new Problem(PROBLEM_CODE.conflict, `Projects ${projects} have their own extracts; remove them (task update --extracts null) ` +
    'with the previous release, then migrate', { blocked }, { reason: { kind: 'task_values_migration_blocked', projects } });
}
const hex = (text: string) => Buffer.from(text).toString('hex').toUpperCase();
/**
 * Writes the plan in the migrator's transaction: each Task's values, and as evidence every Task's body and settings as
 * they were. Stops before writing anything when a project has its own extracts.
 */
export function applyTaskValuesMigration(name: string, db: DatabaseSync): TaskValuesPlan {
  if (name !== TASK_VALUES_MIGRATION || !db.isTransaction) throw new Error('Unexpected data migration name or transaction');
  const { plan: result, values, rows } = plan(db);
  if (result.blocked.length) throw migrationBlocked(result.blocked);
  const insert = db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES (?,?,?)');
  for (const [task, own] of values) for (const [field, value] of Object.entries(own) as [string, FieldValue][])
    insert.run(task, field, JSON.stringify(value));
  const sourceSchema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.type, row.name, row.tbl_name, row.sql]);
  const migration = packagedMigrations('control').find(item => item.name === TASK_VALUES_SQL)!;
  const kept = rows.filter(row => row.body !== '' || row.settings !== null);
  writeMigrationEvidence(db, TASK_VALUES_MIGRATION, { sourceVersion: 16, sourceSchema,
    transformation: { from: 16, to: 16, kind: TASK_VALUES_MIGRATION, checksum: migration.hash },
    operationalAfter: { tables: { task_values: result.rows }, plan: { ...result, blocked: [] } } },
  kept.map(row => ({ table: 'tasks', rowid: row.rowid, cells: [['rowid', 'integer', hex(String(row.rowid))],
    ['external_id', 'text', hex(row.external)], ['body', 'text', hex(row.body)],
    row.settings === null ? ['settings', 'null', ''] : ['settings', 'text', hex(row.settings)]] })));
  return result;
}
