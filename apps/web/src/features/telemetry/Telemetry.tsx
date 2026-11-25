import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TELEMETRY_DELETE_URL, dayRange } from '@alpacawork/contract/telemetry';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeading } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Caret, DisclosureSummary } from '@/components/ui/caret';
import { ReadFailure } from '@/components/ui/loadable';
import { Message } from '@/components/ui/message';
import { SettingRow } from '@/components/settings/SettingRow';
import { i18n } from '@alpacawork/i18n';
import { describeProblem } from '@/features/forms/problem-text';
import { notify, recordFailure } from '@/lib/notify';
import { useTelemetry, useTelemetryHistory } from './data';
import { sentText, willResend } from './sent-text';
import type { TelemetryAttempt } from '@alpacawork/contract/telemetry';
import { deleteSentTelemetry } from './choice';
import { useWorkspaceInfo } from '@/data/queries';
import { TelemetryDetailsLink } from './TelemetryDetailsLink';

function choiceFailure(error: unknown, detail: string) {
  recordFailure(error, 'save usage data choice');
  const diagnostic = describeProblem(error).detail;
  notify.error(i18n.t('panels:telemetry.saveFailed'), { detail: [detail, diagnostic].filter(Boolean).join(' ') });
}

/** What each saved request's outcome says: a delete is never sent again, so its failures read as failures. */
const OUTCOME = {
  report: { accepted: 'accepted', rejected: 'notAccepted', retry: 'notAccepted', unknown: 'noResponse' },
  delete: { accepted: 'deleted', rejected: 'deleteFailed', retry: 'deleteFailed', unknown: 'deleteNoResponse' },
} as const;

/** A day's report is named by its UTC day, as it is counted. */
function dayName(day: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(dayRange(day).start);
}

/** One request or report, folded to its line; opened, it shows the request and the body exactly as sent or to be sent. */
function SentRow({ when, what, outcome, request, body }: { when?: string; what: string; outcome: string; request?: string; body?: string }) {
  return <li className="border-t border-line">
    <details className="group">
      <DisclosureSummary className="flex min-h-10 flex-wrap items-center gap-x-4 py-2 text-base">
        <Caret className="group-open:rotate-90" />
        {when && <span className="tabular-nums">{when}</span>}<span>{what}</span><span className="text-muted">{outcome}</span>
      </DisclosureSummary>
      <pre className="m-0 mb-3 overflow-x-auto rounded-sm bg-lit p-3 text-xs">{[request, body === undefined ? undefined : sentText(body)].filter(Boolean).join('\n\n')}</pre>
    </details>
  </li>;
}

/**
 * Everything this PC sends and has sent, from the same records the sending goes through: today's report so far, the
 * reports waiting to go, and each request as it was saved before it went (deleting included), newest first.
 */
function HistoryDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, i18n } = useTranslation('panels');
  const history = useTelemetryHistory(), data = history.data;
  const time = new Intl.DateTimeFormat(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const json = (value: unknown) => JSON.stringify(value);
  const resent = willResend(data?.log ?? [], new Set(data?.queue.map(item => item.day)));
  const outcomeText = (entry: TelemetryAttempt, again: boolean) => {
    const key = OUTCOME[entry.kind][entry.outcome];
    return again ? `${t(`telemetry.outcome.${key}`)} ${t('telemetry.resend')}` : t(`telemetry.outcome.${key}`);
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent size="large" data-telemetry-history>
      <DialogHeading title={t('telemetry.historyTitle')} description={t('telemetry.historyNote')} />
      <DialogBody>
        {history.isError ? <ReadFailure what={t('telemetry.historyTitle')} error={history.error} retry={() => void history.refetch()} />
          : !data ? <Message tone="waiting" title={t('settings.personal.loading')} />
          : <>
            <h3 className="m-0 mb-1 text-base font-semibold">{t('telemetry.upcoming')}</h3>
            {data.next || data.queue.length ? <ul className="m-0 mb-6 list-none border-b border-line p-0" data-telemetry-upcoming>
              {data.next && <SentRow what={t('telemetry.today', { day: dayName(data.next.day, i18n.language) })}
                outcome={t('telemetry.counting')} body={json(data.next)} />}
              {data.queue.map(item => <SentRow key={item.day} what={t('telemetry.reportOf', { day: dayName(item.day, i18n.language) })}
                outcome={t('telemetry.waiting', { time: time.format(new Date(item.notBefore)) })} body={json(item.report)} />)}
            </ul> : <p className="m-0 mb-6 text-sm text-muted">{data.state === 'on' ? t('telemetry.empty') : t('telemetry.notSendingUpcoming')}</p>}
            <h3 className="m-0 mb-1 text-base font-semibold">{t('telemetry.sentLog')}</h3>
            {data.log.length ? <ul className="m-0 list-none border-b border-line p-0" data-telemetry-log>
              {data.log.map((entry, index) => <SentRow key={`${index}-${entry.at}`} when={time.format(new Date(entry.at))}
                what={entry.kind === 'delete' ? t('telemetry.deleteRequest') : entry.day ? t('telemetry.reportOf', { day: dayName(entry.day, i18n.language) }) : t('telemetry.olderReport')}
                outcome={outcomeText(entry, resent.has(entry))}
                request={`${entry.method} ${entry.url}`} body={entry.kind === 'report' ? entry.body : undefined} />)}
            </ul> : <p className="m-0 text-sm text-muted">{t('telemetry.nothingSent')}</p>}
            {id && <p className="m-0 mt-6 flex flex-wrap items-baseline gap-x-4 text-sm">
              <span className="text-muted">{t('telemetry.idLabel')}</span><code data-telemetry-id className="select-all">{id}</code>
              <a className="inline-link" href={TELEMETRY_DELETE_URL} target="_blank" rel="noreferrer">{t('telemetry.deletePage')}</a></p>}
            <p className="m-0 mt-2 text-sm text-muted">{t('telemetry.fieldsNote')} <TelemetryDetailsLink /></p>
          </>}
        <DialogFooter><Button variant="outline" onClick={onClose}>{t('telemetry.close')}</Button></DialogFooter>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/** Deleting asks once more: the reports are gone at the receiver, and only totals without the number stay. */
function DeleteDialog({ id, sending, onClose }: { id: string; sending: boolean; onClose: () => void }) {
  const { t } = useTranslation('panels');
  const root = useWorkspaceInfo(info => info.root);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try { await deleteSentTelemetry(root); notify.success(t('telemetry.deleted'), { id: 'telemetry' }); onClose(); }
    catch (error) {
      recordFailure(error, 'delete sent usage data');
      notify.error(t('telemetry.deleteFailed'), { detail: describeProblem(error).detail });
    } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent data-telemetry-delete>
      <DialogHeading title={t('telemetry.delete')} />
      <DialogBody>
        <p className="m-0 text-base [word-break:auto-phrase]">{t('telemetry.deleteBody')}</p>
        {sending && <p className="m-0 mt-2 text-base [word-break:auto-phrase]">{t('telemetry.deleteKeepSending')}</p>}
        {/* The ID is only for deleting, so it is shown here: the page takes it when this screen can't be opened. */}
        <p className="m-0 mt-4 text-sm text-muted [word-break:auto-phrase]">{t('telemetry.deleteElsewhere')}</p>
        <p className="m-0 mt-1 flex flex-wrap items-baseline gap-x-4 text-sm">
          <code data-telemetry-id className="select-all">{id}</code>
          <a className="inline-link" href={TELEMETRY_DELETE_URL} target="_blank" rel="noreferrer">{t('telemetry.deletePage')}</a></p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('telemetry.cancel')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => void remove()}>{t('telemetry.deleteConfirm')}</Button>
        </DialogFooter>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}

/**
 * One row at the end of the General tab, as settings lists usually keep it: the switch, why it is safe, and the links to
 * see, delete and read more. Separate from the config.yaml draft: this switch takes effect as soon as it is pressed.
 */
export function TelemetrySection() {
  const { t } = useTranslation('panels');
  const { status, choose, busy } = useTelemetry();
  const [preview, setPreview] = useState(false);
  // The ID the delete dialog was opened with: it stays open on it even if a later read loses the ID.
  const [deleting, setDeleting] = useState<string | null>(null);
  const current = status.data;
  const hint = current?.state === 'blocked' && current.blockedBy ? t(`telemetry.blocked.${current.blockedBy}`)
    : current?.state === 'not_asked' ? t('telemetry.hintAsk') : current?.state === 'needs_reask' ? t('telemetry.hintReask') : t('telemetry.hintOn');
  return <div data-telemetry-settings>
    {status.isError ? <div className="border-t border-line py-2"><ReadFailure what={t('telemetry.readFailed')} error={status.error} retry={() => void status.refetch()} /></div>
      : <SettingRow id="telemetry-switch" label={t('telemetry.label')} hint={status.isPending ? t('settings.personal.loading') : hint}>
        <Switch id="telemetry-switch" aria-label={t('telemetry.label')} checked={current?.state === 'on'}
          disabled={!current || current.state === 'blocked' || busy} onCheckedChange={on => void choose(on ? 'on' : 'off', error => choiceFailure(error, t('telemetry.saveRetry')))} />
      </SettingRow>}
    <p className="m-0 -mt-1 flex flex-wrap gap-x-4 pb-3 text-sm">
      <button type="button" className="inline-link" onClick={() => setPreview(true)}>{t('telemetry.see')}</button>
      {current?.id && <button type="button" className="inline-link" onClick={() => setDeleting(current.id)}>{t('telemetry.delete')}</button>}
      <a className="inline-link" href={TELEMETRY_DELETE_URL} target="_blank" rel="noreferrer">{t('telemetry.deletePage')}</a>
      <TelemetryDetailsLink />
    </p>
    {preview && <HistoryDialog id={current?.id ?? null} onClose={() => setPreview(false)} />}
    {deleting && <DeleteDialog id={deleting} sending={current?.state === 'on'} onClose={() => setDeleting(null)} />}
  </div>;
}

