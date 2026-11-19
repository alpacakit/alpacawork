import { duration, easing, reducedMotion } from '@/lib/motion';
import { NARROW_QUERY } from '@/state/view-store';

export const desktopAnswers = () => !matchMedia(NARROW_QUERY).matches;
/** A chip is one question's answer: its Task, its question's ID and its number, as the draft tells answers apart. */
export const chipKey = (task: string, question: string, n: string) => JSON.stringify([task, question, n]);
export const chipSelector = (task: string, question: string, n: string) =>
  `[data-label-editor] [data-answer-task="${CSS.escape(task)}"][data-answer-question="${CSS.escape(question)}"][data-answer-n="${CSS.escape(n)}"]`;
export const answerFace = (task: string, question: string, n: string, answer?: string) => document.querySelector<HTMLElement>(
  `${chipSelector(task, question, n)}${answer === undefined ? '' : `[data-answer-answer="${CSS.escape(answer)}"]`} > *`);

type Slide = { face: HTMLElement; animation: Animation };
const motions = new Map<Element, ChipMotion>();
export function stopAnswerChips() { for (const motion of motions.values()) motion.stop(); }
export function stopChipMotion(root: Element) { motions.get(root)?.stop(); }

/** One input owns the slides. Unchanged destinations keep their running animation across editor changes. */
class ChipMotion {
  private slides = new Map<string, Slide>();
  private observer: MutationObserver | null = null;
  private cap: ReturnType<typeof setTimeout> | null = null;

  constructor(private root: Element) {
    window.addEventListener('resize', this.stop);
    document.addEventListener('visibilitychange', this.stop);
  }

  stop = () => {
    this.observer?.disconnect(); this.observer = null;
    if (this.cap !== null) clearTimeout(this.cap);
    this.cap = null;
    for (const { animation } of this.slides.values()) animation.cancel();
    this.slides.clear();
    window.removeEventListener('resize', this.stop);
    document.removeEventListener('visibilitychange', this.stop);
    if (motions.get(this.root) === this) motions.delete(this.root);
  };

  private idle() { if (!this.observer && !this.slides.size) this.stop(); }

  private measure(face: HTMLElement, key: string) {
    const box = face.getBoundingClientRect(), slide = this.slides.get(key);
    const transform = slide?.face === face ? new DOMMatrixReadOnly(getComputedStyle(face).transform) : new DOMMatrixReadOnly();
    return { box, layout: { left: box.left - transform.m41, top: box.top - transform.m42 } };
  }

  private animate(key: string, face: HTMLElement, frames: Keyframe[], timing: KeyframeAnimationOptions, time?: CSSNumberish | null) {
    this.slides.get(key)?.animation.cancel();
    const animation = face.animate(frames, timing), slide = { face, animation };
    if (time !== undefined) animation.currentTime = time;
    this.slides.set(key, slide);
    const finished = () => { if (this.slides.get(key) === slide) { this.slides.delete(key); this.idle(); } };
    void animation.finished.then(finished, finished);
  }

  read(except: string | null, delay: number) {
    this.observer?.disconnect();
    if (this.cap !== null) clearTimeout(this.cap);
    const pending = new Set([...this.root.querySelectorAll<HTMLElement>('[data-answer-task]')].flatMap(chip => {
      const task = chip.dataset.answerTask!, question = chip.dataset.answerQuestion!, n = chip.dataset.answerN!, key = chipKey(task, question, n);
      const face = chip.firstElementChild as HTMLElement | null;
      return face && key !== except ? [{ task, question, n, key, ...this.measure(face, key) }] : [];
    }));
    this.observer = new MutationObserver(() => {
      // Snapshot every destination before cancellation or animation changes another chip's layout.
      const measured = [...pending].map(item => {
        const face = answerFace(item.task, item.question, item.n);
        return { item, face, now: face ? this.measure(face, item.key).layout : null };
      });
      for (const { item, face, now } of measured) {
        const { key, layout, box } = item, slide = this.slides.get(key);
        if (!face || !now) { slide?.animation.cancel(); this.slides.delete(key); pending.delete(item); continue; }
        if (Math.abs(layout.left - now.left) < 0.5 && Math.abs(layout.top - now.top) < 0.5) {
          // ProseMirror can replace a face without moving its destination. Carry its timeline to the new DOM node.
          if (slide && slide.face !== face) {
            const effect = slide.animation.effect as KeyframeEffect;
            this.animate(key, face, effect.getKeyframes(), effect.getTiming(), slide.animation.currentTime);
          }
          continue;
        }
        const dx = box.left - now.left, dy = box.top - now.top;
        this.animate(key, face, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: duration('base'), delay, easing: easing('out'), fill: 'backwards' });
        pending.delete(item);
      }
      if (!pending.size) { this.observer?.disconnect(); this.observer = null; this.idle(); }
    });
    this.observer.observe(this.root, { childList: true, subtree: true, attributes: true, characterData: true });
    this.cap = setTimeout(this.stop, duration('slow') * 2);
  }
}

/** Read before an editor change. Retarget only chips whose natural destination changes after it commits. */
export function slideChips(except: string | null = null, delay = 0) {
  const root = document.querySelector('[data-label-editor]');
  if (!root || !desktopAnswers() || reducedMotion() || document.hidden) return () => {};
  let motion = motions.get(root);
  if (!motion) { motion = new ChipMotion(root); motions.set(root, motion); }
  motion.read(except, delay);
  return motion.stop;
}
