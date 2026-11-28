import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/ui/icon';
import { useReplyNavigation } from './reply-navigation';
import { scrollThreadToEnd } from './thread-position';

/**
 * The way down to the latest once the thread is read back: one round mark centred over the thread's foot, shown while
 * what is read is short of the end (the position owner marks it, useThreadPosition). A return from a reply's jump
 * (ReplyReturn) already goes down, so it stands alone then.
 */
export function ToLatest({ area }: { area: RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation('ui');
  const returning = useReplyNavigation(state => !!state.back);
  const holder = area.current;
  const [away, setAway] = useState(false);
  useEffect(() => {
    const scroller = holder?.querySelector<HTMLElement>(':scope > [data-card-scroll]');
    if (!scroller) return;
    const read = () => setAway(scroller.hasAttribute('data-thread-away'));
    const marks = new (scroller.ownerDocument.defaultView ?? window).MutationObserver(read);
    marks.observe(scroller, { attributes: true, attributeFilter: ['data-thread-away'] });
    read();
    return () => marks.disconnect();
  }, [holder]);
  if (!holder || !away || returning) return null;
  const down = () => {
    const scroller = holder.querySelector<HTMLElement>(':scope > [data-card-scroll]');
    if (scroller) scrollThreadToEnd(scroller, true);
  };
  return createPortal(<button type="button" data-coordinator-to-latest aria-label={t('coordinatorCard.toLatest')} title={t('coordinatorCard.toLatest')}
    onPointerDown={event => event.preventDefault()} onClick={down}
    className="absolute bottom-2 left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-lit-line bg-raised text-muted shadow-float hover:bg-hover hover:text-ink pointer-coarse:size-11">
    <Icon name="arrowDown" className="size-4" />
  </button>, holder);
}
