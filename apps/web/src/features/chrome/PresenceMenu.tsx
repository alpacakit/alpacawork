import { ApiError } from '@/data/client';
import { postPresence, usePresenceActivity } from '@/data/presence';
import { useRef, useState } from 'react';
import { moveMenuFocus } from './menu-move';
import { useTranslation } from 'react-i18next';
import { morningUntil, type PauseChoice } from '@alpacawork/contract';
import type { ProjectedIndexDTO } from '@alpacawork/contract/control';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Popup } from '@/components/ui/popup';
import { usePersonalSettings } from '@/data/personal-settings';
import { useFrameSelector } from '@/data/workspace-store';
import { useDialogStore } from '@/state/dialog-store';
import { useNow } from '@/state/clock';
import { cn } from '@/lib/utils';
import { notify } from '@/lib/notify';

const UNKNOWN_PRESENCE = { state: 'away' as const, until: null };

type PresenceState = ProjectedIndexDTO['presence']['state'];

// The colour a mark is cut out of: the page, unless the menu (lit) or a button under the pointer says otherwise.
const CUT_RING = 'ring-2 ring-[color:var(--presence-cut,var(--bg))]';
const CUT_FILL = 'bg-[color:var(--presence-cut,var(--bg))]';
const CUT_ON_HOVER = 'hover:[--presence-cut:var(--hover)]';

/**
 * The state as a chat app shows it: a person with a mark at their foot, the same in the bar and the menu.
 * Present a filled green dot, Away an empty ring, Paused a moon, so each tells by its shape as well as its colour.
 * The mark is cut out of what it sits on, so it stays apart from the person drawn under it.
 */
function PresenceGlyph({ state, className }: { state: PresenceState; className?: string }) {
  return <span aria-hidden="true" data-presence-glyph={state} className={cn('relative inline-flex size-4 flex-none', className)}>
    <Icon name="human" className="size-full" />
    {state === 'present' && <span className={cn('absolute -right-px -bottom-px size-[7px] rounded-full bg-done', CUT_RING)} />}
    {state === 'away' && <span className={cn('absolute -right-px -bottom-px size-[7px] rounded-full border-[1.5px] border-current', CUT_RING, CUT_FILL)} />}
    {state === 'muted' && <span className={cn('absolute -right-0.5 -bottom-0.5 inline-flex rounded-full p-px', CUT_FILL)}>
      <Icon name="moon" className="size-2 fill-current" strokeWidth={2} /></span>}
  </span>;
}

function formatUntil(until: string | null, zone: string, language: string, now: number) {
  if (!until) return { time: '', tomorrow: false };
  const date = new Date(until);
  const time = new Intl.DateTimeFormat(language, { timeZone: zone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const day = new Intl.DateTimeFormat(language, { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return { time, tomorrow: day.format(date) !== day.format(now) };
}

export function PresenceMenu() {
  const present = usePresenceActivity();
  useNow();
  const now = Date.now();
  const { t, i18n } = useTranslation('chrome');
  const presence = useFrameSelector(data => data?.info.presence ?? UNKNOWN_PRESENCE);
  const settings = usePersonalSettings();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const untilParts = formatUntil(presence.until, zone, i18n.language, now);
  const until = untilParts.tomorrow ? t('presence.mutedUntilTomorrow', { time: untilParts.time })
    : t('presence.mutedUntil', { time: untilParts.time });
  const title = presence.state === 'muted' ? t('presence.ariaMuted', { until })
    : t(presence.state === 'present' ? 'presence.ariaPresent' : 'presence.ariaAway');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); setOpen(false); }
    // The menu stays open to try again; what failed is said as the app says any, not in the menu.
    catch (error) { notify.failure(error, { about: 'presence', ...(error instanceof ApiError && error.code === 'restore_changed' ? {} : { text: t('presence.saveFailed') }), from: trigger.current }); }
    finally { setBusy(false); }
  };
  const mute = (choice: PauseChoice) => run(() => postPresence('/pause', { duration: choice, timeZone: zone }, true));
  // Only the open menu names the next morning; the trigger's paused-until text uses the saved instant above.
  const morningParts = open ? formatUntil(new Date(morningUntil(now, { ...settings.values, 'push.timeZone': zone })).toISOString(),
    zone, i18n.language, now) : null;
  const item = (id: string, label: string, action: () => void, icon = false) =>
    <Button key={id} variant="ghost" role="menuitem" disabled={busy} data-presence-item={id}
      onClick={action} className={cn('w-full justify-start gap-2 text-sm narrow:min-h-11', CUT_ON_HOVER)}>
      {icon ? <PresenceGlyph state="muted" className="text-muted" /> : <span className="size-4" />}
      <span className="flex-1 text-left">{label}</span>
    </Button>;
  const radio = (id: 'present' | 'away', label: string, hint: string, action: () => void) =>
    <Button key={id} variant="ghost" role="menuitemradio" aria-checked={presence.state === id} disabled={busy}
      data-presence-item={id} onClick={action} className={cn('w-full justify-start gap-2 text-sm narrow:min-h-11', CUT_ON_HOVER)}>
      <PresenceGlyph state={id} className="text-muted" />
      <span className="flex-1 text-left">{label}</span>
      <span className="text-xs text-soft">{hint}</span>
      {presence.state === id ? <Icon name="check" className="size-3.5" /> : <span className="size-3.5" />}
    </Button>;
  return <>
    <Button ref={trigger} variant="ghost" size="bar" data-presence-trigger
      aria-label={title} title={title} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)} className={cn('text-muted', CUT_ON_HOVER)}>
      <PresenceGlyph state={presence.state} />
    </Button>
    {open && <Popup open onOpenChange={setOpen} label={t('presence.menuLabel')} align="end"
      className="w-64 p-1" anchorRef={trigger}>
      <div role="menu" aria-label={t('presence.menuLabel')} onKeyDown={moveMenuFocus} className="text-sm [--presence-cut:var(--raised)]">
        {presence.state === 'muted' ? <div role="group">
          <div className="flex items-center gap-2 px-2 py-2 text-sm">
            <PresenceGlyph state="muted" className="text-muted" />{t('presence.pausedUntil', { until })}
          </div>
          {item('resume', t('presence.resume'), () => void run(() => postPresence('/resume', undefined, true)))}
        </div> : <div role="group">
          {radio('present', t('presence.present'), t('presence.notSent'), () => void run(present))}
          {radio('away', t('presence.away'), t('presence.sentImmediately'), () => void run(() => postPresence('/away')))}
        </div>}
        <div role="group" className="mt-1 border-t border-line pt-1">
          {item('hour', t('presence.pauseHour'), () => void mute('hour'), true)}
          {item('two-hours', t('presence.pauseTwoHours'), () => void mute('two-hours'))}
          {morningParts && item('morning', morningParts.tomorrow ? t('presence.pauseMorning', { time: morningParts.time })
            : t('presence.pauseMorningToday', { time: morningParts.time }), () => void mute('morning'))}
        </div>
        <div role="group" className="mt-1 border-t border-line pt-1">
          {item('settings', t('presence.settings'), () => {
            setOpen(false); useDialogStore.getState().open('settings', { tab: 'notifications', focus: 'notifications' });
          })}
        </div>
      </div>
    </Popup>}
  </>;
}
