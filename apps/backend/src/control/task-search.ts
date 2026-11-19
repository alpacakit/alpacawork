/** Opt-in Task text search. Callers supply only Tasks admitted by the list's visibility rules. */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { valuesText } from '@alpacawork/contract';
import type { TaskSearchPlace } from '@alpacawork/contract/inputs';
import { FileWriter } from '../raw/storage.js';
import { visitTaskFiles } from './task-files.js';
import { FileJournal } from './file-journal.js';
import { readControl } from './task-store.js';

export type SearchTask = { id: string; path: string };
export type SearchError = { code: string; message: string; path: string };
type MatchSource = { kind: 'id' | 'title' | 'values' }
  | { kind: 'history'; at: string; type: string }
  | { kind: 'runs'; runId: string }
  | { kind: 'files' | 'work'; path: string };
type TextMatch = MatchSource & { excerpt: string; otherMatches: number };
const priority: Record<MatchSource['kind'], number> = { title: 0, values: 1, id: 2, history: 3, runs: 4, files: 5, work: 6 };

/** Map an index in the complete locale lowercase string back to the original code point. */
function originalTextIndex(value: string, folded: string, index: number): number {
  if (value.length === folded.length) return index;
  let low = 0, high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (value.slice(0, middle + 1).toLocaleLowerCase().length > index) high = middle;
    else low = middle + 1;
  }
  // Never start an excerpt in the second code unit of a supplementary character.
  return low > 0 && /[\uDC00-\uDFFF]/u.test(value[low] ?? '') ? low - 1 : low;
}

/** A query never crosses fields. Keep one representative by source priority, with newest History first. */
export class TaskTextMatches {
  readonly matches = new Map<string, TextMatch>();
  private readonly needle: string;
  private readonly historyOrdinals = new Map<string, number>();
  constructor(readonly text: string) { this.needle = text.toLocaleLowerCase(); }
  add(task: string, source: MatchSource, value: string | null, ordinal = -1) {
    if (value === null) return;
    const folded = value.toLocaleLowerCase();
    const matchIndex = folded.indexOf(this.needle);
    if (matchIndex < 0) return;
    const prior = this.matches.get(task);
    if (prior) {
      prior.otherMatches++;
      const rank = priority[source.kind] - priority[prior.kind];
      if (rank > 0) return;
      if (rank === 0) {
        if (source.kind !== 'history' || prior.kind !== 'history') return;
        const time = Date.parse(source.at) - Date.parse(prior.at);
        if (time < 0 || time === 0 && ordinal <= (this.historyOrdinals.get(task) ?? -1)) return;
      }
    }
    const index = originalTextIndex(value, folded, matchIndex);
    // Inspect only the excerpt's neighborhood, even when the matched document is 1 MiB.
    const before = [...value.slice(Math.max(0, index - 60), index)].slice(-30).join('');
    const start = index - before.length;
    const excerptText = [...value.slice(start, start + 160)].slice(0, 80).join('');
    const excerpt = `${start ? '…' : ''}${excerptText.replace(/\s+/gu, ' ')}${start + excerptText.length < value.length ? '…' : ''}`;
    this.matches.set(task, { ...source, excerpt, otherMatches: prior?.otherMatches ?? 0 });
    if (source.kind === 'history') this.historyOrdinals.set(task, ordinal);
  }
}

/** The search place of a file, by its name below the Task's folder. */
const placeOf = (name: string): 'files' | 'work' => name.startsWith('work/') ? 'work' : 'files';

/** One bounded source failure cannot turn an incomplete search into an apparent no-match. */
export function readTaskSearch(root: string, tasks: readonly SearchTask[], places: readonly TaskSearchPlace[],
  found: TaskTextMatches, errors: SearchError[]): void {
  if (!tasks.length || !places.length) return;
  const failed = (path: string, error: unknown) => errors.push({ code: PROBLEM_CODE.readFailed,
    message: error instanceof Error ? error.message : String(error), path });
  if (places.includes('history') || places.includes('runs')) {
    try {
      readControl(root, db => {
        const ids = JSON.stringify(tasks.map(task => task.id));
        if (places.includes('history')) {
          // Read the canonical fields, rather than parsing/projecting whole histories or Run prompts.
          for (const row of db.prepare(`SELECT t.external_id AS task, COALESCE(l.at,q.submitted_at) AS at,
            COALESCE(l.kind,CASE WHEN q.purpose='review_send_back' THEN 'review_sent_back' ELSE 'request_accepted' END) AS kind,
            COALESCE(json_extract(l.entry,'$.title'),l.note_title) AS title,
            COALESCE(json_extract(l.entry,'$.description'),l.note_description) AS description,
            x.text AS fixed_text, json_extract(l.entry,'$.decide') AS decide, NULL AS request_body, l.ordinal AS ordinal,
            CASE WHEN l.kind='dependencies_changed' THEN
              (SELECT group_concat(value,', ' ORDER BY key) FROM json_each(l.entry,'$.dependencies.after')) END AS dependencies_after,
            CASE WHEN l.kind='dependencies_changed' THEN
              (SELECT group_concat(value,', ' ORDER BY key) FROM json_each(l.entry,'$.dependencies.previous')) END AS dependencies_previous
            FROM task_log l JOIN tasks t ON t.id=l.task_id
            LEFT JOIN requests q ON q.id=l.request_id LEFT JOIN log_texts x ON x.log_id=l.id
            WHERE t.external_id IN (SELECT value FROM json_each(?))
            UNION ALL SELECT q.task_id,q.submitted_at,
              CASE WHEN q.purpose='review_send_back' THEN 'review_sent_back' ELSE 'request_accepted' END,
              NULL,NULL,NULL,NULL,q.body,COALESCE(l.ordinal,-1),NULL,NULL
            FROM requests q LEFT JOIN task_log l ON l.request_id=q.id WHERE q.task_id IN (SELECT value FROM json_each(?))
            `).iterate(ids, ids)) {
            const source: MatchSource = { kind: 'history', at: String(row.at), type: String(row.kind) };
            for (const field of ['title', 'description', 'fixed_text', 'request_body', 'dependencies_after', 'dependencies_previous'])
              found.add(String(row.task), source, row[field] === null ? null : String(row[field]), Number(row.ordinal));
            // A question's words are in what its record fixed (decide), read as a Task's values are.
            if (row.decide !== null) found.add(String(row.task), source, valuesText({ decide: JSON.parse(String(row.decide)) }), Number(row.ordinal));
          }
        }
        if (places.includes('runs')) {
          for (const row of db.prepare(`SELECT id,task_id,result,result_state FROM runs
            WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC`).iterate(ids)) {
            if (row.result_state === 'present' && typeof row.result === 'string')
              found.add(String(row.task_id), { kind: 'runs', runId: `R${row.id}` }, row.result);
            else if (row.result_state !== 'pending' && row.result_state !== 'missing')
              failed(`R${row.id}/result`, new Error(`Run result is ${row.result_state}`));
          }
        }
      });
    } catch (error) { failed(places.filter(place => place === 'history' || place === 'runs').join(','), error); }
  }
  if (!places.includes('files') && !places.includes('work')) return;
  let writer: FileWriter | undefined;
  const max = 1024 * 1024;
  try {
    writer = new FileWriter(root);
    const owners = new Map(tasks.map(task => [task.path, task.id]));
    const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    new FileJournal(root).withFileReads(available => visitTaskFiles(writer!, tasks.map(task => task.path), {
      directories: tasks.flatMap(task => places.includes('work') ? [task.path, `${task.path}/work`] : [task.path]),
      descend: (_folder, name) => {
        if (name.split('/').includes('node_modules')) return false;
        if (!name) return true;
        // A directory named exactly work is the work place; a file of that name is an ordinary file.
        return places.includes(name === 'work' ? 'work' : placeOf(name));
      },
      include: (_folder, name) => places.includes(placeOf(name)) && /\.(md|txt|json|csv|html)$/i.test(name),
      maxBytes: max, onError: failed,
    }, (folder, file, directory, basename) => {
      const target = `${folder}/${file.name}`;
      try {
        available(target, () => {
          const bytes = writer!.readAt(directory, basename, max);
          if (bytes === null) throw new Error('File disappeared during search');
          found.add(owners.get(folder)!, { kind: placeOf(file.name), path: file.name },
            decode.decode(bytes));
        });
      } catch (error) {
        if (!(error instanceof Problem && error.code === PROBLEM_CODE.tooLarge)) failed(target, error);
      }
    }));
  } catch (error) { failed('files', error); }
  finally { writer?.close(); }
}
