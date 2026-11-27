import type { DatabaseSync } from 'node:sqlite';
import { serverText, type ServerLocale } from '@alpacawork/i18n/server';
import type { Derived } from '../receiver/push.js';


const OFF_PREFIX = 'automation-off:';
const FAILURE_PREFIX = 'automation-failed:';
const REPORT_PREFIX = 'automation-report:';

export const isAutomationPushKey = (key: string): boolean => key.startsWith(OFF_PREFIX) || key.startsWith(FAILURE_PREFIX) || key.startsWith(REPORT_PREFIX);

const automationTitle = (id: string, name: string): string => `${id} ${name}`.slice(0, 160);

function notice(id: string, key: string, occurredAt: string, title: string, body: string): Derived {
  return { key, urgency: 'normal', occurredAt, payload: { title, body, url: `/?face=automations&automation=${id}`, tag: key } };
}

/** The first revision of the current, unacknowledged off reason is the notification identity. */
export function automationDisableNotices(db: DatabaseSync, language: ServerLocale): Derived[] {
  const rows = db.prepare(`SELECT a.external_id,a.name,a.disabled_reason,c.revision,c.at
    FROM automations a JOIN automation_changes c ON c.automation_id=a.id AND c.revision=(
      SELECT max(disabled.revision) FROM automation_changes disabled
      WHERE disabled.automation_id=a.id AND disabled.kind='disabled'
    ) WHERE a.deleted=0 AND a.disabled_reason IS NOT NULL`).all();
  const t = serverText(language);
  return rows.map(row => {
    const id = String(row.external_id);
    const key = `${OFF_PREFIX}${id}:${row.revision}`;
    return notice(id, key, String(row.at), t('server:push.automationOff', { automation: automationTitle(id, String(row.name)) }),
      row.disabled_reason === 'program_contract_changed' ? t('server:push.automationDefinitionChanged') : t('server:push.automationConsecutiveFailures'));
  });
}

/** Hold the first notice for each unresolved live failure and retain the separate automatic-off notices. */
export function automationNotices(db: DatabaseSync, language: ServerLocale): Derived[] {
  const notices = automationDisableNotices(db, language);
  const t = serverText(language);
  const failures = db.prepare(`SELECT a.external_id,a.name,r.number,r.finished_at
    FROM automations a JOIN automation_runs r ON r.automation_id=a.id AND r.number=(
      SELECT min(f.number) FROM automation_runs f WHERE f.automation_id=a.id AND f.state='failed' AND f.mode='live' AND f.resolved_at IS NULL
    ) WHERE a.deleted=0 AND a.enabled=1`).all();
  for (const row of failures) {
    const id = String(row.external_id), name = String(row.name);
    const key = `${FAILURE_PREFIX}${id}:${row.number}`;
    notices.push(notice(id, key, String(row.finished_at), t('server:push.automationFailed', { automation: automationTitle(id, name) }),
      t('server:push.automationFailureAction')));
  }
  for (const row of db.prepare(`SELECT a.external_id,a.name,r.number,r.summary,r.finished_at,d.report
    FROM automation_runs r JOIN automations a ON a.id=r.automation_id
    LEFT JOIN automation_run_data d ON d.automation_id=r.automation_id AND d.run_number=r.number
    WHERE a.deleted=0 AND r.state='done' AND r.mode='live' AND r.notify=1
    ORDER BY r.finished_at DESC LIMIT 128`).all()) {
    const id = String(row.external_id), key = `${REPORT_PREFIX}${id}:${row.number}`;
    const added = notice(id, key, String(row.finished_at), String(row.name).slice(0, 160), String(row.summary ?? ''));
    if (row.report) added.payload.url += `&automationRun=${row.number}`;
    notices.push(added);
  }
  return notices;
}
