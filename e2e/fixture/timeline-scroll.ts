import { inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
import type { Page } from '@playwright/test';
/** Inert, flat review rows: enough to change the viewport's timeline request during a native wheel scroll. */
import { ControlStore, taskHash } from '@alpacawork/db';
import assert from 'node:assert/strict';
import { record } from '../../tests/runs-fixtures.ts';
import { SAMPLE_PROJECT } from './sample.ts';

export const SCROLL_IDS = Array.from({ length: 64 }, (_, n) => `T${2000 + n}`);

export function seedTimelineScroll(root: string) {
  const store = new ControlStore(root);
  try {
    store.write(db => {
      const project = String(db.prepare("SELECT id FROM tasks WHERE external_id=?").get(SAMPLE_PROJECT.id)!.id);
      const insert = db.prepare(`INSERT INTO tasks
        (id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,revision,created_at,updated_at)
        VALUES (?,'task',?,?,?,?,'active','waiting',0,1,1,?,?)`);
      const value = db.prepare("INSERT INTO task_values(task_id,field_id,value) VALUES (?,'notes',?)");
      const log = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)');
      const person = db.prepare('SELECT agent_id,profile_key FROM placements LIMIT 1').get()!;
      const place = db.prepare('INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at,ended_at) VALUES (?,?,?,?,1,1,?,NULL)');
      const run = db.prepare('INSERT INTO runs(id,record,prompt,result,result_state) VALUES (?,?,?,?,?)');
      const request = db.prepare(`INSERT INTO requests
        (id,task_id,placement_id,placement_revision,task_hash,head_run_id,mode,body,purpose,author,submitted_at,delivery_state)
        VALUES (?,?,?,1,?,NULL,'new',?,'instruction',?,?,'queued')`);
      for (let n = 0; n < 64; n++) {
        const id = `timeline-scroll-${n}`, number = 2000 + n;
        const created = '2026-09-25T01:00:00.000Z', working = '2026-09-25T02:00:00.000Z';
        const reported = new Date(Date.parse('2026-09-25T04:00:00.000Z') + n * 60_000).toISOString();
        insert.run(id, number, project, project, `Scroll review ${String(n).padStart(2, '0')}`, created, reported);
        value.run(id, JSON.stringify('Review the result.'));
        const placementId = `Pscroll-${n}`, taskId = `T${number}`;
        place.run(placementId, taskId, String(person.agent_id), String(person.profile_key), created);
        const requestId = `Qscroll-${n}`;
        request.run(requestId, taskId, placementId, taskHash(id, 1), 'Produce the review result.', JSON.stringify({ kind: 'human' }), working);
        run.run(number, JSON.stringify(record(`R${number}`, { task: taskId, placementId, requestId,
          agent: String(person.profile_key), role: 'owner', cwd: root, state: 'succeeded', created_at: working,
          started_at: working, ended_at: reported, exit: { code: 0, signal: null },
          launch: inertFixtureLaunch('codex') })),
          'Produce the review result.', 'Fixture result.', 'present');
        const entries = [
          { kind: 'created', at: created, fromState: null, toState: 'todo', title: null, description: null, userRequested: true },
          { kind: 'reported', at: working, fromState: 'todo', toState: 'doing', title: 'Work started', description: 'Processing' },
          { kind: 'reported', at: reported, fromState: 'doing', toState: 'waiting', title: 'Result ready', description: 'Review the result' },
        ];
        entries.forEach((entry, ordinal) => {
          const logId = `L-scroll-${n}-${ordinal}`;
          log.run(logId, id, ordinal, JSON.stringify({ ...entry, id: logId,
            actor: ordinal ? { kind: 'placement', placementId } : { kind: 'human' } }));
        });
      }
      db.prepare('UPDATE task_sequence SET next_number=2064 WHERE singleton=1').run();
      db.prepare('UPDATE run_sequence SET next_number=2064 WHERE singleton=1').run();
      const rows = db.prepare("SELECT external_id,state,parent_id,project_task_id FROM tasks WHERE number BETWEEN 2000 AND 2063 ORDER BY number").all();
      assert.deepEqual(rows.map(row => String(row.external_id)), SCROLL_IDS, 'All 64 planned scroll lanes were written');
      assert.equal(rows.length, 64);
      assert.ok(rows.every(row => row.state === 'waiting' && row.parent_id === project && row.project_task_id === project));
    });
  } finally { store.close(); }
}

/** Even the phone's few visible lanes need more than one chronology page. */
export function seedDenseTimelineScroll(root: string) {
  seedTimelineScroll(root);
  const store = new ControlStore(root);
  try {
    store.write(db => {
      const task = db.prepare("SELECT id FROM tasks WHERE external_id='T2063'").get()!;
      const insert = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)');
      for (let n = 0; n < 140; n++) {
        const id = `L-dense-scroll-${n}`;
        insert.run(id, String(task.id), n + 3, JSON.stringify({ id, kind: 'reported',
          at: new Date(Date.parse('2026-09-25T03:00:00Z') + n * 10_000).toISOString(),
          fromState: null, toState: null, title: `Context ${n}`, description: 'Timeline fixture',
          actor: { kind: 'placement', placementId: 'Pscroll-63' } }));
      }
    });
  } finally { store.close(); }
}

/** The screen reads up to 2000 records a page; these seeds fill a smaller one, so a viewport still takes several pages here. Call after the test's own route, which then sees the smaller page. */
export const timelineInSmallPages = (page: Page) => page.route('**/api/task/timeline?**', route => {
  const url = new URL(route.request().url());
  url.searchParams.set('limit', '200');
  return route.fallback({ url: url.toString() });
});
