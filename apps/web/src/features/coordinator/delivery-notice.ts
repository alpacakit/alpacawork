import { useLayoutEffect } from 'react';
import { notify } from '@/lib/notify';

/** Delivery has one notice per fixed request, independent of the surface that attempted it. */
export const deliveryNoticeId = (root: string, requestId: string) => `coordinator-delivery:${JSON.stringify([root, requestId])}`;
type NoticeKind = 'delivery' | 'withdrawal-unknown' | 'operation';
type Options = { kind?: NoticeKind; action?: { label: string; run: () => void }; confirmation?: string };
type Notice = Options & { checked: boolean };
// Ephemeral notification intent, consumed once at admission; the outbox owns delivery facts.
const notices = new Map<string, Notice>();
const surfaces = new Map<object, { id: string; kind: NoticeKind }>();
const visible = (id: string, kind: NoticeKind) => kind !== 'operation' && [...surfaces.values()].some(surface => surface.id === id && surface.kind === kind);
/** Only an actual message/last-words representation can carry its own delivery uncertainty. */
export function useDeliverySurface(root: string, shown: boolean, requestId?: string, kind: NoticeKind = 'delivery') {
  useLayoutEffect(() => {
    if (!shown || !requestId) return;
    const token = {}, id = deliveryNoticeId(root, requestId);
    surfaces.set(token, { id, kind });
    if (notices.get(id)?.kind === kind) notify.dismiss(id);
    return () => { surfaces.delete(token); };
  }, [root, shown, requestId, kind]);
}
export function deliveryNotice(root: string, requestId: string, text: string, options: Options = {}) {
  const id = deliveryNoticeId(root, requestId);
  const notice = { ...options, kind: options.kind ?? 'operation', checked: !!options.confirmation && !!notices.get(id)?.checked };
  notices.set(id, notice);
  if (visible(id, notice.kind)) { notify.dismiss(id); return; }
  notify.error(text, { id, from: 'coordinator', ongoing: true, action: options.action && {
    label: options.action.label, run: () => { const current = notices.get(id); if (current?.confirmation) current.checked = true; options.action!.run(); }
  } });
}
/** Update the same ongoing event; notify owns whether that event was hidden by its reader. */
export function reviseDeliveryNotice(root: string, requestId: string, text: string) {
  const notice = notices.get(deliveryNoticeId(root, requestId));
  if (notice) deliveryNotice(root, requestId, text, notice);
}
/** Admission consumes uncertainty once. An explicit reader check leaves its result in this same slot. */
export function acceptDeliveryNotice(root: string, requestId: string) {
  const id = deliveryNoticeId(root, requestId), notice = notices.get(id);
  if (!notice) return;
  notices.delete(id);
  if (notice.checked && notice.confirmation) notify.success(notice.confirmation, { id, from: 'coordinator' });
  else notify.dismiss(id);
}
/** Cancellation/refusal/closed scope ends both the card and any pending check confirmation. */
export function endDeliveryNotice(root: string, requestId: string) {
  const id = deliveryNoticeId(root, requestId);
  notices.delete(id); notify.dismiss(id);
}
