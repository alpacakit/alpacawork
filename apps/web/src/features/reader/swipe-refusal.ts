import { useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { scrollMotion } from "@/lib/motion";
import { notify, useToasts } from "@/lib/notify";
import type { MissingAnswer } from "@/features/coordinator/reader-send";

/**
 * The question a right swipe was last refused for (askChoice), for its section to mark under its choices until it goes;
 * `words`: its Other is chosen and waits for what to say; `said`: the reason went out as a notice, so the section
 * need not say it again. One at a time: a later swipe takes over.
 */
export const useAskedChoice = create<{ asked: MissingAnswer & { at: number; said: boolean } | null }>(() => ({ asked: null }));
const SAYS_MS = 3000, RING_MS = 1600, CLEAR_PX = 12;
let ring: { group: HTMLElement; timer: number } | null = null;
let says: number | undefined;
type Box = { top: number; bottom: number; left: number; right: number };
/**
 * What stands over the reader wherever it is put: the coordinator (its one line, its input, its conversation: moved
 * anywhere on a computer), the conversation's notice over it, and the notices.
 */
const OVER_READER = "[data-coordinator-card] > *, [data-coordinator-capsule], [data-composer-frame], [data-coordinator-panel], [data-coordinator-pill], [data-toast]";
/** The section a refused swipe rings: its choices, from the Recommended label over them down to the line under them. */
function sectionOf(question: HTMLElement, group: HTMLElement): Box {
  const box = group.getBoundingClientRect(), hint = question.querySelector("[data-ask-hint]")?.getBoundingClientRect();
  const labels = [...group.querySelectorAll("[data-recommended]")].map(each => each.getBoundingClientRect().top);
  return { top: Math.min(box.top, ...labels), bottom: Math.max(box.bottom, hint?.bottom ?? box.bottom), left: box.left, right: box.right };
}
/** What a refused swipe brings into sight: each choice of `group` (with the Recommended label over it), and the line under them when it says why. */
function choicesOf(question: HTMLElement, group: HTMLElement): Box[] {
  const boxes = [...group.children].filter(each => each.getClientRects().length).map(each => {
    const box = each.getBoundingClientRect(), label = each.querySelector("[data-recommended]")?.getBoundingClientRect();
    return { top: Math.min(box.top, label?.top ?? box.top), bottom: box.bottom, left: box.left, right: box.right };
  });
  const hint = question.querySelector("[data-ask-hint]");
  if (hint?.textContent?.trim()) boxes.push(hint.getBoundingClientRect());
  return boxes;
}
/**
 * How far to scroll `area` (within how far it can, each way) to bring the asked choices into sight: the move that leaves
 * none under a notice, then shows the most of them to press (all but the foot of each, an eighth, may stand under something: a choice in a gap a
 * little short of it), then the most whole, then the most CLEAR_PX clear too, then its whole `section` (ringed, the
 * line under it) clear too, then the earliest first of them (it is read from its first choice), then the least move
 * (none when none shows more).
 * Seen is under the reader's header at its open height (--reader-header-h: scrolled back up, it comes back), and
 * clear of what stands over the reader (as drawn now) across
 * each choice: what stands beside a choice covers none of it. A gap too small for a whole choice is never chosen.
 */
function clearing(area: HTMLElement, choices: Box[], section: Box) {
  const view = area.getBoundingClientRect();
  const top = Math.max(view.top + (Number.parseFloat(getComputedStyle(area).getPropertyValue("--reader-header-h")) || 0), 0);
  const bottom = Math.min(view.bottom, innerHeight);
  const over = [...area.ownerDocument.querySelectorAll<HTMLElement>(OVER_READER)].map(each => each.getBoundingClientRect())
    .filter(each => each.width && each.height);
  // `gap` around each, or (`short`) its foot let under.
  const seen = (by: number, gap: number, short = false, of = choices) => of.map(choice => {
    const from = choice.top - by - gap, to = choice.bottom - by + gap - (short ? (choice.bottom - choice.top) / 8 : 0);
    // A pixel either way, as a scroll lands on whole pixels.
    return from >= top - 1 && to <= bottom + 1
      && !over.some(each => each.left < choice.right && each.right > choice.left && each.top < to - 1 && each.bottom > from + 1);
  });
  const whole = (by: number, gap: number, short = false) => seen(by, gap, short).filter(Boolean).length;
  // None under a notice, even in part: a notice floats over them (what else stands over the reader hides them whole).
  const notices = [...area.ownerDocument.querySelectorAll<HTMLElement>("[data-toast]")].map(each => each.getBoundingClientRect() as Box);
  const under = (by: number) => choices.filter(choice => notices.some(each => each.left < choice.right && each.right > choice.left
    && each.top < choice.bottom - by - 1 && each.bottom > choice.top - by + 1)).length;
  // The first of them to press: the question is read from its first choice down.
  const first = (by: number) => { const at = seen(by, 0, true).indexOf(true); return at < 0 ? choices.length : at; };
  const least = -area.scrollTop, most = area.scrollHeight - area.clientHeight - area.scrollTop;
  // Each choice's top just under, or its foot just over, an edge of what is seen, CLEAR_PX clear or touching.
  const moves = new Set([0]);
  for (const choice of [...choices, section]) for (const gap of [CLEAR_PX, 0]) {
    for (const edge of [top, ...over.map(each => each.bottom)]) moves.add(choice.top - edge - gap);
    for (const edge of [bottom, ...over.map(each => each.top)]) moves.add(choice.bottom - edge + gap);
  }
  const scored = [...moves].map(by => Math.min(Math.max(by, least), most))
    .map(by => ({ by, rank: [-under(by), whole(by, 0, true), whole(by, 0), whole(by, CLEAR_PX), +seen(by, CLEAR_PX, false, [section])[0]!,
      -first(by), -Math.abs(by)] }));
  return scored.reduce((a, b) => {
    const at = b.rank.findIndex((each, n) => each !== a.rank[n]);
    return at >= 0 && b.rank[at]! > a.rank[at]! ? b : a;
  }).by;
}
/**
 * The one notice a refused swipe gives: the app's error notice (lib/notify), one at a time (`REFUSED`), none while another
 * is up, so that one stays in reach and the reason is said under the choices instead; but where the question is not
 * drawn there is nowhere else to say it (`only`), and it is said even then.
 */
const REFUSED = "reader-refused";
const free = () => !useToasts.getState().toasts.some(each => each.id !== REFUSED);
/** What the notice up was told for (useReaderSend's missing, as a key): it goes once that no longer holds (useSwipeRefusal). */
let toldFor: string | null = null;
function tell(words: string, missing: MissingAnswer, only = false) {
  if (!only && !free()) return false;
  if (!notify.error(words, { id: REFUSED })) return false;
  toldFor = JSON.stringify(missing);
  return true;
}
/** Once what is drawn has been drawn (two frames) and the notices have come in (their motion ended, where they stand). */
function drawn(at: Document, then: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const coming = [...at.querySelectorAll<HTMLElement>("[data-toast]")].flatMap(each => each.getAnimations());
    void Promise.allSettled(coming.map(each => each.finished)).then(then);
  }));
}
/** What a refused swipe says it waits for: a choice, words for a question with no choices, or words after Other. */
type Reason = "choose" | "write" | "words";
/**
 * Says why a send waits on a question: a short notice (tell), the question's choices brought clear of what stands over
 * the reader only when they are not wholly seen, and ringed for a moment (`data-asked`). The section (WaitingReportActions reads
 * useAskedChoice) says the reason under the choices only when the notice did not, and offers to write after an empty
 * Other. A question not drawn (folded away) is named in the notice. Focus stays where it is, so no keyboard comes up.
 */
function askChoice(area: HTMLElement | null, missing: MissingAnswer, why: (reason: Reason) => string) {
  const questions = [...area?.querySelectorAll<HTMLElement>("[data-question]") ?? []];
  const question = questions.find(each => each.dataset.question === missing.n);
  const group = question?.querySelector<HTMLElement>('[role="group"]');
  const reason: Reason = missing.words ? "words" : question?.dataset.written !== undefined ? "write" : "choose";
  const words = why(reason);
  if (!area || !question || !group?.getClientRects().length) { tell(words, missing, true); return; }
  const said = tell(words, missing);
  if (ring) { clearTimeout(ring.timer); delete ring.group.dataset.asked; void ring.group.offsetWidth; }
  group.dataset.asked = "";
  ring = { group, timer: window.setTimeout(() => { delete group.dataset.asked; ring = null; }, RING_MS) };
  const asked = { ...missing, at: performance.now(), said };
  useAskedChoice.setState({ asked });
  clearTimeout(says);
  says = window.setTimeout(() => { if (useAskedChoice.getState().asked?.at === asked.at) useAskedChoice.setState({ asked: null }); }, SAYS_MS);
  // Clear the choices against the actual common overlays after the hint and toast have been drawn.
  drawn(area.ownerDocument, () => {
    if (useAskedChoice.getState().asked?.at !== asked.at || !question.isConnected) return;
    const by = clearing(area, choicesOf(question, group), sectionOf(question, group));
    if (by) area.scrollBy({ top: by, behavior: scrollMotion() });
  });
}

/**
 * A right swipe with no answer to send: what ReaderSwipe calls to say why (askChoice, in the reader's words), and the
 * life of its notice, which goes once what it said no longer holds (the card answered, words written, another card read)
 * or the reader it was told over is put away.
 */
export function useSwipeRefusal(content: RefObject<HTMLElement | null>, missing: MissingAnswer | null) {
  const { t } = useTranslation("reader");
  const missingKey = missing ? JSON.stringify(missing) : "";
  const takeBack = () => { notify.dismiss(REFUSED); toldFor = null; };
  useEffect(() => { if (toldFor !== null && toldFor !== missingKey) takeBack(); }, [missingKey]);
  useEffect(() => () => { if (toldFor !== null) takeBack(); }, []);
  return () => {
    if (!missing) return;
    // Nothing answered names no question (any of them may be answered first); the ring shows where to start.
    askChoice(content.current, missing, reason => reason === "words" ? t("swipe.notSaid") : reason === "write" ? t("swipe.notWritten") : t("swipe.notAnswered"));
  };
}
