import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { sizeObserver, useSurfaceDocument } from '@/lib/surface';
import { useEscapeLayer, ESCAPE_LAYER } from '@/lib/escape-layer';
import { useCloseOnPhoneBack } from '@/lib/close-on-back';
import { Icon } from '@/components/ui/icon';
import { LabelFace } from './LabelFace';
import { onReaderMove } from '@/components/ui/hover-card';

/** The × at a label's end in the input: it takes the label out without opening its card. */
export function LabelRemove({ name, remove }: { name: string; remove: () => void }) {
  return <button type="button" aria-label={name} onMouseDown={event => event.preventDefault()} onClick={remove}
    className="grid size-4 place-items-center rounded-full hover:bg-line"><Icon name="close" className="size-3" /></button>;
}

/** Task, project and reply labels share the same disclosure, surface, dismissal and placement. */
export function LabelPopover({ kind, name, face, faceStyle, tail, header, children, actions }: {
  kind: 'task' | 'project' | 'reply'; name: string; face: ReactNode; faceStyle?: CSSProperties; tail?: ReactNode; header: ReactNode;
  children: ReactNode; actions: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = () => setOpen(false);
  return <>
    <LabelFace kind={kind} ref={anchor} contentEditable={false} style={faceStyle}>
      <button type="button" aria-haspopup="dialog" aria-expanded={open} className="inline-flex min-w-0 items-center gap-1"
        onMouseDown={event => event.preventDefault()} onClick={() => setOpen(!open)}>{face}</button>{tail}
    </LabelFace>
    {open && <LabelCard anchor={anchor} name={name} header={header} actions={actions(close)} close={close}>{children}</LabelCard>}
  </>;
}

/**
 * The card a label opens, and a task named in a text opens the same: above what opened it when there is room,
 * below otherwise. Esc, a press outside it or Back on a phone closes it. A card opened from inside another card is
 * drawn in it, so pressing it is not a press outside the first. Opened by what held the focus (a key, a press that
 * focuses), the focus goes to its first action and comes back when it closes; a label that leaves the focus in the
 * input keeps it there.
 */
export function LabelCard({ anchor, name, header, children, actions, close, cardRef, autoFocus = true, onPointerEnter, onPointerLeave }: {
  anchor: RefObject<HTMLElement | null>; name: string; header: ReactNode; children: ReactNode; actions: ReactNode; close: () => void;
  cardRef?: RefObject<HTMLDivElement | null>; autoFocus?: boolean;
  onPointerEnter?: HTMLAttributes<HTMLDivElement>["onPointerEnter"]; onPointerLeave?: HTMLAttributes<HTMLDivElement>["onPointerLeave"];
}) {
  const own = useRef<HTMLDivElement>(null);
  const card = cardRef ?? own;
  const at = useSurfaceDocument();
  useEscapeLayer(true, ESCAPE_LAYER.popup, () => { close(); return true; });
  useCloseOnPhoneBack(true, close);
  useLayoutEffect(() => {
    // The focus as the card's document holds it: an element of the conversation's own window is not this window's HTMLElement.
    if (!autoFocus) return;
    const active = at.activeElement as HTMLElement | null;
    const opener = active && anchor.current?.contains(active) ? active : null;
    if (!opener) return;
    // A reference belongs to the task it was read in. Another task taking its place retires that
    // focus destination before React removes its DOM. Labels in the input keep their own destination.
    let restore = true;
    const stop = opener.closest('[data-reader-content]') ? onReaderMove(() => { restore = false; }) : undefined;
    card.current?.querySelector<HTMLElement>('button, a[href]')?.focus({ preventScroll: true });
    return () => {
      stop?.();
      if (restore && opener.isConnected && (!at.activeElement || at.activeElement === at.body || card.current?.contains(at.activeElement))) opener.focus({ preventScroll: true });
    };
  }, [at, autoFocus]);
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!card.current?.contains(event.target as globalThis.Node) && !anchor.current?.contains(event.target as globalThis.Node)) close();
    };
    at.addEventListener('pointerdown', away, true);
    return () => at.removeEventListener('pointerdown', away, true);
  }, [at]);
  useLayoutEffect(() => {
    if (!card.current || !anchor.current) return;
    const view = at.defaultView!;
    const place = () => {
      if (!card.current || !anchor.current) return;
      const popup = card.current, label = anchor.current.getBoundingClientRect();
      const room = { width: view.innerWidth, height: view.innerHeight };
      popup.style.maxHeight = `${Math.max(0, room.height - 16)}px`;
      const measured = popup.getBoundingClientRect();
      const above = label.top - 6 - measured.height;
      const below = label.bottom + 6;
      const preferred = above >= 8 ? above : below;
      popup.style.left = `${Math.max(8, Math.min(label.left, room.width - measured.width - 8))}px`;
      popup.style.top = `${Math.max(8, Math.min(preferred, room.height - measured.height - 8))}px`;
    };
    place();
    const resize = sizeObserver(card.current, place);
    resize.observe(card.current);
    view.addEventListener('resize', place);
    at.addEventListener('scroll', place, true);
    return () => { resize.disconnect(); view.removeEventListener('resize', place); at.removeEventListener('scroll', place, true); };
  }, [at]);
  return createPortal(<div ref={card} data-badge-card onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} role="dialog" aria-label={name}
    className="fixed z-(--layer-popover) w-72 max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-lit-line bg-raised p-3 text-sm text-ink shadow-float"
    style={{ left: 8, top: 8 }}>
    <div className="flex items-center gap-1.5 text-xs text-muted">{header}</div>
    {children}<div className="mt-2 flex gap-2">{actions}</div>
  </div>, anchor.current?.closest<HTMLElement>('[data-badge-card]') ?? at.body);
}
