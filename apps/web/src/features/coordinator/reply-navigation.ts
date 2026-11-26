import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { create } from 'zustand';
import { scrollMotion } from '@/lib/motion';
import { scrollThreadTo } from './thread-position';
/** One pending jump and one return point, scoped to the shown conversation. Nothing is persisted. */
export type ReplyOrigin = { id?: string; at: string };
type Jump = { id: string; origin?: ReplyOrigin };
export const useReplyNavigation = create<{
  jump: Jump | null;
  back: ReplyOrigin | null;
}>(() => ({ jump: null, back: null }));
export const goToReply = (id: string, origin: ReplyOrigin) => useReplyNavigation.setState({ jump: { id, origin } });
export function returnFromReply() {
  const back = useReplyNavigation.getState().back;
  if (back) useReplyNavigation.setState({ jump: { id: back.id ?? 'input' }, back: null });
}

/**
 * Where a reply's target is: drawn once revealed (`here`), to be read first (`later`: asked again at each drawing until
 * it is here or gone), or not in the conversation (`gone`).
 */
export type Revealed = 'here' | 'later' | 'gone';
/** Consume once, reveal, then resolve against that committed rendering. Missing targets are discarded. */
export function useReplyNavigationOwner(root: RefObject<HTMLElement | null>, scope: string | undefined, asked: number,
  reveal: (id: string) => Revealed) {
  const jump = useReplyNavigation(state => state.jump);
  const back = useReplyNavigation(state => state.back);
  const [pending, setPending] = useState<Jump | null>(null);
  const [later, setLater] = useState<Jump | null>(null);
  const revealNow = useRef(reveal); revealNow.current = reveal;
  const [flash, setFlash] = useState<HTMLElement | null>(null);
  const resolve = (target: Jump) => {
    const revealed = revealNow.current(target.id);
    setLater(revealed === 'later' ? target : null);
    if (revealed === 'here') setPending(target);
  };
  useLayoutEffect(() => {
    useReplyNavigation.setState({ jump: null, back: null }); setPending(null); setLater(null); setFlash(null);
  }, [scope, asked]);
  useLayoutEffect(() => {
    if (!jump) return;
    useReplyNavigation.setState({ jump: null });
    resolve(jump);
  }, [jump]);
  // Read first: each drawing may hold it now.
  useLayoutEffect(() => { if (later) resolve(later); });
  useLayoutEffect(() => {
    if (!pending) return;
    setPending(null);
    const at = root.current?.ownerDocument;
    if (!at) return;
    const selector = pending.origin ? `[data-coordinator-message="${CSS.escape(pending.id)}"] [data-ask-answer]`
      : pending.id === 'input' ? '[data-one-input-area]' : `[data-coordinator-origin="${CSS.escape(pending.id)}"]`;
    const destination = at.querySelector<HTMLElement>(selector);
    if (!destination) return;
    const scroller = root.current?.closest('[data-card-scroll]');
    scrollThreadTo(root.current!, destination, { block: scroller && destination.offsetHeight > scroller.clientHeight * 0.8 ? 'start' : 'center', behavior: scrollMotion() });
    if (pending.id !== 'input') setFlash(destination);
    useReplyNavigation.setState({ back: pending.origin ?? null });
  }, [pending, root]);
  useEffect(() => {
    if (!flash) return;
    flash.dataset.replyFlash = '';
    const timer = setTimeout(() => setFlash(null), 2400);
    return () => { clearTimeout(timer); delete flash.dataset.replyFlash; };
  }, [flash]);
  useEffect(() => {
    if (!back || !root.current) return;
    const at = root.current.ownerDocument, scroller = root.current.closest('[data-card-scroll]') ?? root.current.parentElement;
    const destination = at.querySelector<HTMLElement>(back.id ? `[data-coordinator-origin="${CSS.escape(back.id)}"]` : '[data-one-input-area]');
    if (!destination || !scroller) return;
    let manual = false;
    const reading = () => { manual = true; };
    const onScroll = () => {
      if (!manual) return;
      const box = destination.getBoundingClientRect(), view = scroller.getBoundingClientRect();
      if (box.top >= view.top && box.bottom <= view.bottom) useReplyNavigation.setState({ back: null });
    };
    scroller.addEventListener('scroll', onScroll);
    scroller.addEventListener('wheel', reading); scroller.addEventListener('touchmove', reading);
    return () => { scroller.removeEventListener('scroll', onScroll); scroller.removeEventListener('wheel', reading); scroller.removeEventListener('touchmove', reading); };
  }, [back, root]);
  useEffect(() => () => { useReplyNavigation.setState({ jump: null, back: null }); }, []);
}
