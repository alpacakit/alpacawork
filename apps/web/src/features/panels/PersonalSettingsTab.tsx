import { RegionSkeleton } from '@/components/ui/skeleton';
import { useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { personalSettings, quietTimes, type SettingDefinition, type SettingValues } from '@alpacawork/contract';
import { Button } from '@/components/ui/button';
import { FieldHint } from '@/components/ui/field';
import { SettingSection } from '@/components/settings/SettingSection';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingControl } from '@/components/settings/SettingControl';
import { usePersonalSettings, visibleSettingValue } from '@/data/personal-settings';
import { intentKey, useWriteIntent } from '@/data/write-intent';
import { PushSection } from './PushSection';
import { TelemetrySection } from '@/features/telemetry/Telemetry';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { ReadFailure } from "@/components/ui/loadable";
import { useReadState, useWriteDisabled } from '@/data/queries';
import { resources } from '@/data/resources';
import { useConnection } from '@/data/connection';
import { useDialogStore } from '@/state/dialog-store';
import { restartGuide } from '@/features/guide/guide-state';
import { useGuideScreen } from '@/features/guide/use-guide';

/**
 * What one row says and allows while its values are saved, a row of three as a row of one. A change made elsewhere or a
 * save not known is put right here, and a refused save is a toast (data/personal-settings.ts). While one value is saving
 * or not known, the row waits; settings are sent only where the shared predicate admits them for the read they were made
 * on.
 */
function useSettingRow(keys: readonly string[]) {
  const { t } = useTranslation('panels');
  const state = usePersonalSettings();
  const intents = keys.map(key => useWriteIntent(intentKey(state.root ?? '', `personal-setting:${key}`, null)));
  const unproven = intents.some(intent => intent.unproven);
  const statuses = intents.map(intent => intent.status);
  const issue = statuses.find(status => status === 'unconfirmed') ?? statuses.find(status => status === 'conflict');
  const saving = statuses.includes('pending');
  const denied = useWriteDisabled(resources.personalSettings(state.root ?? '').queryKey);
  return { state, locked: denied || state.status !== 'ready' || saving || issue === 'unconfirmed',
    status: saving ? t('settings.personal.saving') : undefined,
    error: unproven ? t('forms:writeFailure.unproven') : !saving && issue ? t(`settings.personal.issue.${issue}`) : undefined,
    retry: !unproven && issue === 'unconfirmed' && state.root && <Button variant="quiet"
      onClick={() => void state.load(state.root!, true)}>{t('settings.personal.retry')}</Button> };
}

function PersonalSettingRow({ definition }: { definition: SettingDefinition }) {
  const { t } = useTranslation('panels');
  const { state, locked, status, error, retry } = useSettingRow([definition.key]);
  const id = `setting-${definition.key.replaceAll('.', '-')}`;
  const label = t(definition.labelKey);
  const value = visibleSettingValue(definition.key, state) ?? definition.defaultValue;
  // A way back (shownWhenChanged) appears once its value is changed and stays for this opening, so turning it back does
  // not make it jump away under the pointer.
  const changed = useRef(false);
  if (value !== definition.defaultValue) changed.current = true;
  if (definition.shownWhenChanged && !changed.current) return null;
  return <SettingRow id={id} label={label}
    hint={definition.helpKey ? t(definition.helpKey) : undefined} status={status} error={error}>
    {/* On a phone the way to read again stands under the choice, so the choice keeps its width beside the name. */}
    <div className="flex items-center gap-2 narrow:flex-col-reverse narrow:items-end">
      {retry}
      <SettingControl definition={definition} id={id} value={value} label={label}
        disabled={locked}
        optionLabel={(optionLabelKey) => t(optionLabelKey)} onChange={(next) => void state.save(definition.key, next)} />
    </div>
  </SettingRow>;
}

const QUIET_KEYS = ['push.quiet', 'push.quietFrom', 'push.quietTo'];
const quietTimeOptions = quietTimes.map(time => <option key={time} value={time}>{time}</option>);
/** A quiet time not read yet: what its definition says it starts as. */
const quietTime = (key: string, values: SettingValues) => String(values[key] ?? personalSettings.find(item => item.key === key)?.defaultValue);

function QuietHoursRow() {
  const { t } = useTranslation('panels');
  const { state, locked, status, error, retry } = useSettingRow(QUIET_KEYS);
  const enabled = state.values['push.quiet'] === true;
  const save = (key: string, value: string | boolean) => state.save(key, value);
  const times = <div className="flex items-center gap-2 narrow:col-span-2 narrow:row-start-3 narrow:mt-2">
    <NativeSelect variant="field" className="w-24" aria-label={t('settings.personal.quietFrom')}
      value={quietTime('push.quietFrom', state.values)} disabled={locked || !enabled}
      onChange={event => void save('push.quietFrom', event.target.value)}>
      {quietTimeOptions}
    </NativeSelect>
    <span aria-hidden="true">{t('settings.personal.quietSeparator')}</span>
    <NativeSelect variant="field" className="w-24" aria-label={t('settings.personal.quietTo')}
      value={quietTime('push.quietTo', state.values)} disabled={locked || !enabled}
      onChange={event => void save('push.quietTo', event.target.value)}>
      {quietTimeOptions}
    </NativeSelect>
  </div>;
  return <SettingRow id="setting-push-quiet" label={t('settings.personal.quiet')}
    hint={t('settings.personal.quietHelp')}
    status={status} error={error}>
    <div className="flex items-center gap-4 narrow:contents">
      {retry}
      {times}
      <Switch id="setting-push-quiet" aria-label={t('settings.personal.quiet')} checked={enabled}
        disabled={locked} onCheckedChange={value => void save('push.quiet', value)}
        className="narrow:col-start-2 narrow:row-start-1" />
    </div>
  </SettingRow>;
}

/**
 * The getting-started guide, kept on this browser: shown again from its first screen (restartGuide), settings closed.
 * Offered on a computer's screen alone, where that guide is shown (useGuideScreen).
 */
function GuideRow() {
  const { t } = useTranslation('panels');
  if (useGuideScreen() !== "computer") return null;
  return <SettingRow id="setting-guide" label={t('settings.personal.guide')} hint={t('settings.personal.guideHelp')}>
    {/* Named by its own words ("Show again"), the row's name said after it: the row's label names the setting, not the press. */}
    <Button variant="outline" aria-describedby="setting-guide-label" onClick={() => { restartGuide(); useDialogStore.getState().close(); }}>
      {t('settings.personal.guideShow')}</Button>
  </SettingRow>;
}

/** Whether this person's values are still being read: their rows stand as placeholders meanwhile. */
const usePersonalLoading = () => usePersonalSettings(state => state.status === 'idle' || state.status === 'loading');

/** What the tabs of these values (General, Notifications) show when a read fails. */
function PersonalReadState() {
  const { t } = useTranslation('panels');
  const state = usePersonalSettings();
  // Read again and not read, the last settings read stay shown and in use; out of reach that is the progress line's.
  const read = useReadState(resources.personalSettings(state.root ?? '').queryKey);
  const offline = useConnection((connection) => connection.offline);
  const reloadFailed = state.status === 'ready' && !!read.error && !read.fetching && !offline;
  return <>
    {state.status === 'error' && <ReadFailure what={t('settings.personal.loadError')} error={state.loadError ?? undefined}
      retry={state.root ? () => void state.load(state.root!, true) : undefined} />}
    {reloadFailed && <ReadFailure what={t('settings.personal.reloadFailed')} error={read.error} note={t('settings.personal.previousShown')}
      retry={read.retry} />}
  </>;
}

const shown = (definitions: readonly SettingDefinition[]) => definitions.filter(item => item.owner === 'person' && !item.hidden);

/**
 * General: who the values reach, how the screen looks, the guide shown again, then usage data, where settings lists usually keep it; what the
 * dialog adds (`children`, its Advanced options) closes the list.
 */
export function GeneralSettingsTab({ definitions = personalSettings, children }: { definitions?: readonly SettingDefinition[]; children?: ReactNode }) {
  const { t } = useTranslation('panels');
  const loading = usePersonalLoading();
  return <>
    <FieldHint className="mb-6">{t('settings.scope.server')}</FieldHint>
    <div className="border-b border-line">
      <PersonalReadState />
      {loading ? <RegionSkeleton shape="settingRows" rows={3} />
        : shown(definitions).filter(item => item.group === 'display').map(item => <PersonalSettingRow key={item.key} definition={item} />)}
      <GuideRow />
      <TelemetrySection />
      {children}
    </div>
  </>;
}

const TIMING_KEYS = ['push.awayAfter', 'push.quiet'];
/**
 * Notifications, in the order they are set up: the devices that receive them (nothing arrives until one is registered),
 * what is told, then when it is held back.
 */
export function NotificationSettingsTab({ definitions = personalSettings, focusNotifications = false }: {
  definitions?: readonly SettingDefinition[]; focusNotifications?: boolean;
}) {
  const { t } = useTranslation('panels');
  const notifications = shown(definitions).filter(item => item.group === 'notifications');
  const hasQuietHours = definitions.some(item => item.key === 'push.quiet');
  const loading = usePersonalLoading();
  return <div>
    <PersonalReadState />
    <SettingSection id="settings-notifications" title={t('settings.personal.pushDevices')}>
      <PushSection focusHeading={focusNotifications} />
    </SettingSection>
    <SettingSection id="settings-notification-events" title={t('settings.personal.pushEvents')} note={t('settings.personal.pushScope')}>
      {loading ? <RegionSkeleton shape="settingRows" rows={3} />
        : notifications.filter(item => !TIMING_KEYS.includes(item.key)).map(item => <PersonalSettingRow key={item.key} definition={item} />)}
    </SettingSection>
    <SettingSection id="settings-notification-timing" title={t('settings.personal.pushTiming')}>
      {notifications.filter(item => item.key === 'push.awayAfter').map(item => <PersonalSettingRow key={item.key} definition={item} />)}
      {hasQuietHours && <QuietHoursRow />}
    </SettingSection>
  </div>;
}
