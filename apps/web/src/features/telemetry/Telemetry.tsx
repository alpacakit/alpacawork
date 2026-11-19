import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TELEMETRY_DELETE_URL, dayRange } from '@alpacawork/contract/telemetry';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeading } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { ReadFailure } from '@/components/ui/loadable';
import { Message } from '@/components/ui/message';
import { SettingRow } from '@/components/settings/SettingRow';
import { i18n } from '@alpacawork/i18n';
import { describeProblem } from '@/features/forms/problem-text';
import { notify, recordFailure } from '@/lib/notify';
import { useTelemetry, useTelemetryPreview } from './data';
import { deleteSentTelemetry } from './choice';
import { useWorkspaceInfo } from '@/data/queries';
import { TelemetryDetailsLink } from './TelemetryDetailsLink';

function choiceFailure(error: unknown, detail: string) {
  recordFailure(error, 'save usage data choice');
  const diagnostic = describeProblem(error).detail;
  notify.error(i18n.t('panels:telemetry.saveFailed'), { detail: [detail, diagnostic].filter(Boolean).join(' ') });
}

function PreviewDialog({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation('panels');
  const preview = useTelemetryPreview(), next = preview.data?.next;
  const day = next ? new Intl.DateTimeFormat(i18n.language, { month: 'numeric', day: 'numeric', timeZone: 'UTC' }).format(dayRange(next.day).start) : null;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent data-telemetry-preview>
      <DialogHeading title={t('telemetry.previewTitle')} description={day ? t('telemetry.previewNote', { day }) : undefined} />
      <DialogBody>
        {preview.isError ? <ReadFailure what={t('telemetry.previewTitle')} error={preview.error} retry={() => void preview.refetch()} />
          : preview.isPending ? <Message tone="waiting" title={t('settings.personal.loading')} />
          : next ? <><pre className="m-0 max-h-[70vh] overflow-auto rounded-sm bg-lit p-3 text-xs">{JSON.stringify(next, null, 2)}</pre>
            <p className="m-0 mt-1 text-sm text-muted">{t('telemetry.idNote')}</p></>
          : preview.data?.state === 'on' ? <Message tone="empty" title={t('telemetry.empty')} /> : <Message tone="info" title={t('telemetry.notSending')} />}
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
 * One row at the end of the Server tab, as settings lists usually keep it: the switch, why it is safe, and the links to
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
      <TelemetryDetailsLink />
    </p>
    {preview && <PreviewDialog onClose={() => setPreview(false)} />}
    {deleting && <DeleteDialog id={deleting} sending={current?.state === 'on'} onClose={() => setDeleting(null)} />}
  </div>;
}

