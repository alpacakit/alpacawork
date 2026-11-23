import { stringify } from 'yaml';
import { fixtureAgentSetting, inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
import { RunStore } from '@alpacawork/runs';
import { TaskTransition } from '@alpacawork/backend/test-dist/control/task-transition.js';
/** Seeded fictional Request identity/body/head in a current-baseline fixture. */
import assert from 'node:assert/strict';
import { assertInertFixtureRuns } from './inert-runs.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openControlDatabase } from '@alpacawork/db';

// The frozen reference target is a project; current public IDs expose that same row as P2.
export const historyReferenceId = 'P2';

export function seedHistoryRequest(root: string, supplements = 85) {
  mkdirSync(join(root, '.alpacawork'), { mode: 0o700 });
  const seeded = JSON.parse(readFileSync('tests/fixtures/history-request.json', 'utf8'));
  const { request: head, log, body } = seeded;
  const id = head.id as string;
  assert.equal(Buffer.byteLength(body), head.bodyBytes);
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);
  try {
    const triggers = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
    for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
    db.exec('PRAGMA foreign_keys=OFF; DELETE FROM run_sequence; DELETE FROM task_sequence; DELETE FROM workspace_identity');
    // Preserve the legacy schema and adapt its Request vocabulary for the current fixture.
    const data = readFileSync('tests/fixtures/control-v8-data.sql', 'utf8').split('\n').map(line => {
      if (line.startsWith('INSERT INTO "requests"')) return line.replace('"origin"', '"purpose"')
        .replace(/,'(human|main|placement|review|returns)',/g, (_, origin: string) =>
          `,'${origin === 'review' ? 'review_send_back' : origin === 'returns' ? 'return_continuation' : 'instruction'}',`);
      // Its Tasks have empty bodies; the current tasks table has no body column (Task values live apart).
      if (line.startsWith('INSERT INTO "tasks"')) return line.replace('"state"', '"base_state","hold"').replace(',"body"', '')
        .replace(/^(.*?VALUES\((?:[^,]*,){6}'(?:[^']|'')*'),'',/, '$1,')
        .replace(/,'(todo|doing|waiting|error|done|stopped)',([01]),/, ",'$1',0,$2,");
      return line;
    }).join('\n');
    db.exec(data);
    assert.equal(db.prepare('SELECT kind FROM tasks WHERE external_id=?').get(historyReferenceId)?.kind, 'project');
    // The frozen seed predates required project colors; only this synthetic current fixture is adapted.
    db.exec("UPDATE tasks SET settings=json_set(COALESCE(settings, '{}'), '$.color', '#39659b') WHERE kind='project'");
    db.prepare('UPDATE tasks SET number=9001,title=? WHERE number=3').run(seeded.taskTitle);
    db.exec("UPDATE placements SET task_id='T9001' WHERE task_id='T3'; UPDATE requests SET task_id='T9001' WHERE task_id='T3'");
    // The seeded quote belongs to this Request; it has no separate coordinator turn.
    const focalAuthor = { ...head.author, ...(typeof head.author.quote === 'object' ? { quote: head.author.quote.text } : {}) };
    const review = db.prepare("SELECT * FROM requests WHERE id='v6-review'").get()!;
    db.prepare('UPDATE requests SET id=?,placement_id=?,head_run_id=?,about_run_id=?,mode=?,body=?,author=?,submitted_at=? WHERE id=?')
      .run(id, review.placement_id!, log.runId, log.runId, head.mode, body, JSON.stringify(focalAuthor), head.submittedAt, 'v6-review');
    const prior = db.prepare("SELECT * FROM requests WHERE task_id='T9001' AND id<>?").get(id)!;
    for (const row of db.prepare('SELECT id,record FROM runs').all()) {
      const run = JSON.parse(String(row.record));
      run.task = 'T9001';
      run.id = row.id === 1 ? log.runId : head.runId;
      run.requestId = row.id === 1 ? prior.id : id;
      if (run.resumes === 'R1') run.resumes = log.runId;
      run.cwd = root;
      // Seeded history must never launch a provider.
      run.launch = inertFixtureLaunch('codex');
      db.prepare('UPDATE runs SET id=?,record=? WHERE id=?').run(Number(run.id.slice(1)), JSON.stringify(run), Number(row.id));
    }
    db.prepare('UPDATE task_log SET id=?,request_id=? WHERE id=?').run(id, id, 'v6-review');
    for (const row of db.prepare('SELECT id,entry FROM task_log WHERE entry IS NOT NULL').all()) {
      const entry = JSON.parse(String(row.entry));
      if (entry.runId === 'R1') entry.runId = log.runId;
      if (entry.id === 'LSTARTR1') entry.id = 'LSTART' + log.runId;
      db.prepare('UPDATE task_log SET id=?,entry=? WHERE id=?').run(entry.id, JSON.stringify(entry), String(row.id));
    }
    assert.ok(db.prepare('SELECT count(*) AS n FROM cli_operations').get()!.n, 'keep even synthetic receipt bytes');
    for (const trigger of triggers) db.exec(String(trigger.sql));
    db.exec('PRAGMA foreign_keys=ON');
    // This synthetic current database also needs the admission evidence a real RequestService now records.
    const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
    try { store.write(runs => {
      for (const request of runs.requests()) new TaskTransition().captureStartGrant({ store, runs }, request.taskId, request.id, request.author);
    }); } finally { store.close(); }
    // Legitimate notes and an answered question coexist with the instruction across page boundaries.
    const taskUUID = String(db.prepare("SELECT id FROM tasks WHERE external_id='T9001'").get()!.id);
    let ordinal = Number(db.prepare('SELECT max(ordinal)+1 AS n FROM task_log WHERE task_id=?').get(taskUUID)!.n);
    const add = (entry: { id: string; [field: string]: unknown }, text?: string) => {
      db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)')
        .run(entry.id, taskUUID, ordinal++, JSON.stringify(entry));
      if (text) db.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)').run(entry.id, text);
    };
    const common = { at: head.submittedAt, fromState: null, toState: null };
    add({ ...common, id: 'screen-legitimate-comment', kind: 'reported', title: 'Legitimate supplement',
      description: supplements > 85 ? `Do not remove this comment. Read ${historyReferenceId}.` : 'Do not remove this comment', actor: { kind: 'human' } });
    add({ ...common, id: 'screen-question', kind: 'asked', title: 'Choose an approach', description: 'Choose A or B',
      actor: { kind: 'placement', placementId: review.placement_id }, askedTo: null,
      decide: [{ decide_question: 'Choose an approach', decide_choices: [{ decide_choice: 'A' }, { decide_choice: 'B' }] }] });
    add({ ...common, id: 'screen-answer', kind: 'answered', title: 'Choose A', description: 'Keep this answer',
      actor: { kind: 'human' }, questionId: 'screen-question' }, 'Keep this answer');
    db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)').run('screen-answer', 'screen-question');
    for (let n = 0; n < supplements; n++) add({ ...common, id: 'zz-page-comment-' + n.toString().padStart(3, '0'),
      kind: 'reported', title: 'Page supplement ' + n, description: 'Independent legitimate note ' + n, actor: { kind: 'human' } });
    const reference = db.prepare('SELECT l.entry,l.request_id,t.external_id FROM task_log l JOIN tasks t ON t.id=l.task_id WHERE l.id=?').get(id)!;
    assert.equal(reference.external_id, 'T9001');
    assert.equal(reference.entry, null);
    assert.equal(db.prepare('SELECT body FROM requests WHERE id=?').get(id)!.body, body);
    assert.equal(reference.request_id, id);
    assert.equal(db.prepare('SELECT head_run_id FROM requests WHERE id=?').get(id)!.head_run_id, 'R9001');
    assert.equal(db.prepare('SELECT id FROM runs WHERE request_id=?').get(id)!.id, 9002);
    assertInertFixtureRuns(db.prepare('SELECT record FROM runs').all().map(row => JSON.parse(String(row.record))));
    writeFileSync(join(root, 'config.yaml'), stringify({ agents: { claude: fixtureAgentSetting('claude') } }));
    return { id, body: body as string, at: head.submittedAt as string };
  } finally { db.close(); }
}
