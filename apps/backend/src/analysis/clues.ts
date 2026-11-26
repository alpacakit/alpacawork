/**
 * What a unit shows about its three axes beyond its counts: where the user was while it waited for them, how the user
 * answered its questions, which questions an instruction replaced, and what the user's later instructions were.
 */
import { FIX_KINDS, INSTRUCTION_KINDS } from '@alpacawork/raw';
import type { AnalysisAcceptedTotals } from '@alpacawork/contract/analysis';
import { finishedClock, type AnalysisFacts, type Unit } from './facts.js';
import { addSplit, emptySplit, splitWaits, type Activity, type WaitSplit } from './presence.js';
import { clocks } from './rules.js';

type Clues = Pick<AnalysisAcceptedTotals, 'waits' | 'answerItems' | 'instructions' | 'questionsReplaced'>;
/** Sums of clues over units, before the instruction kinds are written out as rows. */
export class CluesSum {
  readonly waits = emptySplit();
  readonly answerItems = { total: 0, choice: 0, recommended: 0, recommendable: 0, other: 0, stop: 0, unmatched: 0 };
  private readonly kinds = new Map<string, number>();
  private readonly fixes = new Map<string, number>();
  private total = 0; private labeled = 0;
  private questionsReplaced = 0;

  add(unit: Unit, waits: WaitSplit) {
    addSplit(this.waits, waits);
    for (const question of unit.asked) {
      if (question.replacedBy !== null) this.questionsReplaced++;
      if (!question.answered) continue;
      if (!question.parts) continue;
      for (const item of question.parts.items) {
        const items = this.answerItems;
        items.total++;
        items[item.kind]++;
        if (item.kind === 'choice' && item.recommended) items.recommended++;
        if (question.recommends[item.n - 1]) items.recommendable++;
      }
    }
    this.total += unit.instructions.count; this.labeled += unit.instructions.labels.length;
    for (const label of unit.instructions.labels) {
      this.kinds.set(label.kind, (this.kinds.get(label.kind) ?? 0) + 1);
      for (const fix of label.fixes) this.fixes.set(fix, (this.fixes.get(fix) ?? 0) + 1);
    }
  }

  clues(): Clues {
    // Most first; a tie keeps the kinds' own order.
    const rows = <K extends string>(kinds: readonly K[], counts: Map<string, number>) => kinds
      .map(kind => ({ kind, count: counts.get(kind) ?? 0 })).filter(row => row.count > 0).sort((a, b) => b.count - a.count);
    return { waits: { ...this.waits }, answerItems: { ...this.answerItems },
      questionsReplaced: this.questionsReplaced,
      instructions: { total: this.total, unlabeled: this.total - this.labeled,
        kinds: rows(INSTRUCTION_KINDS, this.kinds), fixes: rows(FIX_KINDS, this.fixes) } };
  }
}

/**
 * Each unit's waits split by where the user was, kept per line of the user's actions (a new line when an action or a
 * message changes) and per unit (a unit counted again is a new one). A split that still moves with the time of the read
 * (a wait still open, or one ended within 30 minutes of the last action) is made again at each read.
 */
const splits = new WeakMap<() => readonly Activity[], WeakMap<Unit, WaitSplit>>();
export function waitsOf(facts: AnalysisFacts, unit: Unit, now: number): WaitSplit {
  let kept = splits.get(facts.activity);
  if (!kept) splits.set(facts.activity, kept = new WeakMap());
  const found = kept.get(unit);
  if (found) return found;
  const ended = unit.outcome.finishedAt ?? unit.outcome.doneAt;
  const from = Date.parse(unit.outcome.requestedAt), to = ended ? Date.parse(ended) : now;
  const clock = finishedClock(unit);
  const waits = (clock ?? clocks(unit.log, unit.ownQuestions, unit.childQuestions, unit.launches, from, to, now)).waits;
  const id = unit.node.id;
  const { split, settled } = splitWaits(waits, facts.activity(), task => task === id || facts.rootOf.get(task) === id, now);
  if (clock && settled) kept.set(unit, split);
  return split;
}
