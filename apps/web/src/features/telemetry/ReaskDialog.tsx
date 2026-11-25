import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeading } from '@/components/ui/dialog';
import { isAgentView } from '@/lib/agent-view';
import { notify, recordFailure } from '@/lib/notify';
import { describeProblem } from '@/features/forms/problem-text';
import { useTelemetry } from './data';
import { TelemetryDetailsLink } from './TelemetryDetailsLink';
import { TELEMETRY_FIELD_EXAMPLES, telemetryFieldKey } from './field-text';

/**
 * Asked once per page while a consent to send no longer covers what is sent (more kinds of information, or new terms):
 * nothing is sent until the person answers. Closing it answers nothing; it asks again on the next page load.
 * An agent checking the screen is never asked: only a person can choose.
 */
export function TelemetryReaskDialog() {
  const { t } = useTranslation('panels');
  const { status, choose, busy } = useTelemetry();
  const [closed, setClosed] = useState(false);
  const current = status.data;
  if (closed || isAgentView() || current?.state !== 'needs_reask') return null;
  const answer = async (choice: 'on' | 'off') => {
    if (await choose(choice, error => {
      recordFailure(error, 'save usage data choice');
      notify.error(t('telemetry.saveFailed'), { detail: describeProblem(error).detail });
    })) setClosed(true);
  };
  const added = current.added ?? null;
  return <Dialog open onOpenChange={open => { if (!open) setClosed(true); }}>
    <DialogContent data-telemetry-reask>
      <DialogHeading title={t('telemetry.reaskTitle')} description={t(added?.length ? 'telemetry.reaskAdded' : 'telemetry.reaskChanged')} />
      <DialogBody>
        {added?.length ? <ul className="m-0 mb-3 list-none border-t border-line p-0" data-telemetry-added>
          {added.map(field => <li key={field} data-field={field} className="border-b border-line py-2">
            <span className="block text-base">{t(telemetryFieldKey(field))}</span>
            <span className="block text-sm text-muted">{t('telemetry.example', { value: TELEMETRY_FIELD_EXAMPLES[field] ?? '' })}
              <span className="ml-2 text-xs">({field})</span></span>
          </li>)}
        </ul> : null}
        <p className="m-0 text-sm text-muted [word-break:auto-phrase]">{t('telemetry.reaskNote')} <TelemetryDetailsLink /></p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void answer('off')}>{t('telemetry.reaskOff')}</Button>
          <Button disabled={busy} onClick={() => void answer('on')}>{t('telemetry.reaskOn')}</Button>
        </DialogFooter>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
