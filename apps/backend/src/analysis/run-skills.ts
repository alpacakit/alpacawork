import type { DatabaseSync } from 'node:sqlite';
import { RUN_STATE, runFolder, runNumber } from '@alpacawork/contract/run';
import { faultReason } from '@alpacawork/core';
import { controlRoot } from '@alpacawork/db';
import { TALLY_VERSION } from '../agents/adapters/tally.js';
import { readRunTallyObservation, type RunTallyObservation } from './tally-file.js';
import { tallyEligible, tallyStartedAtMs, tallyUnfinished } from './tally-scope.js';

/** A derived index of the exact same completed tallies that analysis receives. */
export function saveRunSkills(db: DatabaseSync, batch: readonly RunTallyObservation[], since: number): void {
  const save = db.prepare(`INSERT INTO analysis_run_skills(run_id,parser_version,state,names,observed_at)
    SELECT id,?,?,?,? FROM runs WHERE id=? AND ${tallyEligible}
    ON CONFLICT(run_id) DO UPDATE SET parser_version=excluded.parser_version,state=excluded.state,names=excluded.names,
      observed_at=excluded.observed_at
    WHERE (analysis_run_skills.parser_version,analysis_run_skills.state,analysis_run_skills.names)
      IS NOT (excluded.parser_version,excluded.state,excluded.names)`);
  for (const { id, tally, observedAt } of batch)
    save.run(tally.v, tally.state, JSON.stringify(Object.keys(tally.skills).sort()), observedAt, runNumber(id), since);
}

export function observedSkillNames(db: DatabaseSync, project: string | null): string[] {
  return db.prepare(`SELECT DISTINCT name.value AS skill FROM analysis_run_skills s
    JOIN runs r ON r.id=s.run_id JOIN tasks t ON t.external_id=r.task_id
    JOIN tasks p ON p.id=t.project_task_id, json_each(s.names) name
    WHERE s.parser_version=? AND (? IS NULL OR p.external_id=?) ORDER BY skill`)
    .all(TALLY_VERSION, project, project).map(row => String(row.skill));
}

export type SkillMatch = 'match' | 'miss' | 'pending' | 'unavailable';

/** A Run begun before this event contributes once it finishes. Process evidence can arrive after a report. */
export function matchTaskSkills(db: DatabaseSync, task: string, at: string, since: number | null,
  wanted: readonly string[], deadline: number): SkillMatch {
  const rows = db.prepare(`SELECT r.id,r.unfinished,r.collectible,s.state AS tally_state,s.names,s.observed_at FROM (
      SELECT id, (${tallyUnfinished}) AS unfinished,
        ((${tallyUnfinished} AND ${tallyStartedAtMs}>=?) OR (${tallyEligible})) AS collectible
      FROM runs WHERE task_id=? AND ${tallyStartedAtMs}<=? AND state<>?
        AND NOT (json_extract(record,'$.pids.agent') IS NULL AND (
          (state=? AND json_extract(record,'$.reason') IS 'launch') OR
          (state=? AND json_extract(record,'$.reason') IS 'stopped')
        ))
    ) r LEFT JOIN analysis_run_skills s ON s.run_id=r.id AND s.parser_version=?`)
    .all(since, since, task, Date.parse(at), RUN_STATE.joined, RUN_STATE.failed, RUN_STATE.cancelled, TALLY_VERSION);
  const root = controlRoot(db);
  let pending = false, incomplete = false;
  const names = new Set(wanted);
  for (const row of rows) {
    let state = row.tally_state, observedAt = row.observed_at;
    let used = row.names === null ? [] : JSON.parse(String(row.names)) as string[];
    // The tally file is published before the parent receives the worker's batch. Read it during that gap,
    // including on restart, so expiry cannot race an index write that has not happened yet.
    if (state === null && row.collectible === 1 && row.unfinished === 0 && root !== undefined) {
      try {
        const evidence = readRunTallyObservation(runFolder(root, `R${row.id}`));
        if (evidence) {
          ({ observedAt } = evidence);
          state = evidence.tally.state;
          used = Object.keys(evidence.tally.skills);
        }
      } catch (error) {
        if (faultReason(error).kind !== 'system_error') throw error;
        // Leave this Run undecided until the deadline. The tally worker reports its read fault.
      }
    }
    if (observedAt !== null && Number(observedAt) > deadline) {
      incomplete = true;
      continue;
    }
    if (used.some(name => names.has(name))) return 'match';
    if (state === null && row.collectible === 1) pending = true;
    else if (state !== 'complete') incomplete = true;
  }
  return pending ? 'pending' : incomplete ? 'unavailable' : 'miss';
}
