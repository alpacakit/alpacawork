import { useLayoutEffect, useMemo } from 'react';
import { duration, easing, reducedMotion } from '@/lib/motion';
import { answerFace, chipKey, chipSelector, desktopAnswers, slideChips, stopAnswerChips } from '@/features/coordinator/editor/answer-chips';
import { clamp, endOf, lengthFor, resting, retarget, sampleAt, transition, type Leg, type Sample } from './answer-cue-motion';
import { become, boxOf, draw, lookOf, shapeOf, stillOf, type Look, type Shape } from './answer-cue-view';

type Press = { button: HTMLElement; task: string; question: string; n: string; answer: string; adds: boolean };
type Frame = { sample: Sample; at: number };
type Session = {
  source: symbol; press: Press; frameId: number; waiting: number; view: Shape | null; leaving: HTMLElement | null;
  leavingFade: { at: number; opacity: number } | null; hidden: HTMLStyleElement | null; chip: { box: ReturnType<typeof boxOf>; look: Look } | null;
  leg: Leg | null; start: number; last: Frame | null; previous: Frame | null; answer: string | null;
};

/** One shape per question across the reader and time notes. Each press changes only its destination and source. */
class AnswerCues {
  private sessions = new Map<string, Session>();
  private fades = new Map<Animation, symbol>();
  private watching = false;
  private reduced: MediaQueryList | null = null;

  private watch() {
    if (this.watching) return;
    this.watching = true;
    window.addEventListener('resize', this.clear);
    document.addEventListener('visibilitychange', this.clear);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.reduced.addEventListener('change', this.clear);
  }

  clear = () => {
    for (const [key, session] of this.sessions) this.finish(key, session);
    stopAnswerChips();
    this.release();
  };

  private release() {
    for (const animation of this.fades.keys()) animation.cancel();
    this.fades.clear();
    window.removeEventListener('resize', this.clear);
    document.removeEventListener('visibilitychange', this.clear);
    this.reduced?.removeEventListener('change', this.clear);
    this.reduced = null;
    this.watching = false;
  }

  private idle() {
    if (!this.sessions.size && !this.fades.size) this.release();
  }

  private finish(key: string, session: Session) {
    cancelAnimationFrame(session.frameId);
    session.view?.shape.remove(); session.leaving?.remove(); session.hidden?.remove();
    this.sessions.delete(key);
    this.idle();
  }

  clearSource(source: symbol) {
    for (const [key, session] of this.sessions) if (session.source === source) this.finish(key, session);
    for (const [animation, owner] of this.fades) if (owner === source) { animation.cancel(); this.fades.delete(animation); }
    if (!this.sessions.size && !this.fades.size) stopAnswerChips();
    this.idle();
  }

  press = (press: Press, source: symbol) => {
    if (!desktopAnswers() || document.hidden) return;
    const key = chipKey(press.task, press.question, press.n), existing = this.sessions.get(key);
    if (existing) {
      existing.press = press;
      existing.source = source;
      existing.waiting = 0;
      this.conceal(existing, press.adds);
      slideChips(key, press.adds ? 0 : duration('fast'));
      return;
    }
    const face = answerFace(press.task, press.question, press.n);
    const session: Session = { source, press, frameId: 0, waiting: 0, view: null, leaving: null, leavingFade: null, hidden: null,
      chip: face ? { box: boxOf(face), look: lookOf(face) } : null,
      leg: null, start: 0, last: null, previous: null, answer: null };
    this.sessions.set(key, session);
    this.watch();
    if (!reducedMotion()) {
      this.conceal(session, press.adds);
      if (press.adds && face) session.leaving = stillOf(face, key);
      slideChips(key, press.adds ? 0 : duration('fast'));
    }
    session.frameId = requestAnimationFrame(now => this.step(key, session, now));
  };

  private conceal(session: Session, hide: boolean) {
    if (!hide) { session.hidden?.remove(); session.hidden = null; return; }
    if (session.hidden) return;
    const style = document.createElement('style');
    style.dataset.answerCueHidden = '';
    style.textContent = `${chipSelector(session.press.task, session.press.question, session.press.n)} > * { opacity: 0 !important; }`;
    document.head.append(style);
    session.hidden = style;
  }

  private step(key: string, session: Session, now: number) {
    const { press } = session;
    if (!press.button.isConnected) { this.finish(key, session); return; }
    const face = answerFace(press.task, press.question, press.n, press.answer);
    const destination = press.adds && face ? boxOf(face) : null;
    // The draft commits after the press. Only this loop waits for its current destination, never an old callback.
    if (press.adds && (!destination || destination.width === 0)) {
      if (session.view || ++session.waiting > 30) { this.finish(key, session); return; }
      session.frameId = requestAnimationFrame(time => this.step(key, session, time));
      return;
    }
    if (reducedMotion()) {
      if (face && press.adds) {
        const fade = face.animate([{ opacity: 0 }, { opacity: 1 }], { duration: duration('fast'), easing: easing('out') });
        this.fades.set(fade, session.source);
        const finished = () => { this.fades.delete(fade); this.idle(); };
        void fade.finished.then(finished, finished);
      }
      this.finish(key, session); return;
    }
    const toward = press.adds ? 1 : 0;
    const to = press.adds ? destination! : boxOf(press.button);
    // Read the old chip before creating or drawing the flight, which changes layout.
    const leavingSize = session.leaving && !session.leavingFade
      ? { width: session.leaving.offsetWidth, height: session.leaving.offsetHeight } : null;
    const action = transition(session.leg?.toward ?? null, toward, session.answer !== null && session.answer !== press.answer);
    if (action === 'start') {
      const from = press.adds ? boxOf(press.button) : session.chip?.box;
      const chip = press.adds ? lookOf(face!) : session.chip?.look;
      if (!from || !chip) { this.finish(key, session); return; }
      session.view = shapeOf(key, lookOf(press.button), chip);
      session.leg = { from: resting(from, press.adds ? 0 : 1), toward, velocity: null, correction: null, length: lengthFor(duration('slow'), from, to) };
      session.start = now;
    } else if (action === 'turn' || action === 'retarget') {
      const last = session.last!, previous = session.previous ?? last, dt = Math.max(1, last.at - previous.at);
      const velocity = { x: (last.sample.box.x - previous.sample.box.x) / dt, y: (last.sample.box.y - previous.sample.box.y) / dt,
        width: (last.sample.box.width - previous.sample.box.width) / dt, height: (last.sample.box.height - previous.sample.box.height) / dt };
      if (action === 'turn') {
        if (toward === 0 && session.leaving && !session.leavingFade) session.leavingFade = { at: now, opacity: Number(session.leaving.style.opacity || 1) };
        session.leg = { from: last.sample, toward, velocity, correction: null, length: lengthFor(duration('slow'), last.sample.box, to) };
        session.start = last.at;
      } else {
        session.leg = retarget(session.leg!, to, (last.at - session.start) / session.leg!.length, last.sample.box, velocity, duration('fast'));
      }
    }
    if (press.adds && session.answer !== press.answer) { become(session.view!, face!); session.answer = press.answer; }
    const leg = session.leg!, end = endOf(leg), progress = Math.min(end, (now - session.start) / leg.length);
    const sample = sampleAt(leg, to, progress);
    draw(session.view!, sample);
    session.view!.shape.style.willChange = progress / end > 0.9 ? 'auto' : 'transform, width, height';
    if (session.leaving) {
      if (session.leavingFade) {
        const opacity = session.leavingFade.opacity * (1 - clamp((now - session.leavingFade.at) / duration('fast')));
        session.leaving.style.opacity = String(opacity);
        if (opacity === 0) { session.leaving.remove(); session.leaving = null; }
      } else {
        session.leaving.style.opacity = String(clamp(Math.hypot(sample.box.x - to.x, sample.box.y - to.y) / (to.height * 1.5)));
        session.leaving.style.transform = `translate3d(${to.x - leavingSize!.width / 2}px, ${to.y - leavingSize!.height / 2}px, 0)`;
      }
    }
    session.previous = session.last; session.last = { sample, at: now };
    if (progress === end) { this.finish(key, session); return; }
    session.frameId = requestAnimationFrame(time => this.step(key, session, time));
  }
}

const cues = new AnswerCues();

/** A source that disappears or becomes unavailable releases its pending presses and flights. */
export function useCueAnswer(disabled: boolean) {
  const source = useMemo(() => Symbol(), []);
  useLayoutEffect(() => () => cues.clearSource(source), [source, disabled]);
  return useMemo(() => (press: Press) => cues.press(press, source), [source]);
}

/** Closing, changing task/pane, or unmounting releases every decoration before the next paint. */
export function useAnswerCueLifetime(task: string | null, pane: string) {
  useLayoutEffect(() => cues.clear, [task, pane]);
}
