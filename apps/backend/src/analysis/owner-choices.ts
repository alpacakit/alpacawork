import type { AnalysisOwnerChoices } from '@alpacawork/contract/analysis';
import { sumRunUsage } from '@alpacawork/contract';
import type { Unit } from './facts.js';
import { median, type Launch } from './rules.js';

type SelectedUnit = Pick<Unit, 'outcome' | 'launches'> & { node: Pick<Unit['node'], 'id' | 'state'> };
type ModelRow = AnalysisOwnerChoices['rows'][number];
type Row<Choice> = Omit<ModelRow, 'choice'> & { choice: Choice };
type Judgment = ModelRow['judgments'][number];
type PickChoice<Choice> = (run: Launch) => { key: string; choice: Choice } | null;
const counts = (): ModelRow['counts'] => ({ passed: 0, reworked: 0, stopped: 0, pending: 0, unjudged: 0 });
const idOrder = (a: string, b: string) => Number(a.slice(1)) - Number(b.slice(1));
const first = (times: readonly (string | null)[]) =>
  times.reduce((earliest, time) => time === null ? earliest : Math.min(earliest, Date.parse(time)), Infinity);

function choicesBefore<Choice>(unit: SelectedUnit, pick: PickChoice<Choice>) {
  const { acceptedAt, firstStoppedAt, firstReviewReworkAt } = unit.outcome;
  const before = first([acceptedAt, firstStoppedAt, firstReviewReworkAt]);
  const choices = new Map<string, Choice>();
  let missing = false;
  for (const run of unit.launches) {
    if (run.task !== unit.node.id || run.role !== 'owner' || run.started >= before) continue;
    const selected = pick(run);
    if (selected) choices.set(selected.key, selected.choice);
    else missing = true;
  }
  return { choices, missing };
}

function costOf(launches: readonly Launch[], now: number): Judgment['cost'] {
  const { tokens, tokensUnknown, runMs } = sumRunUsage(launches, now);
  return { outputTokens: tokensUnknown === 0 ? tokens?.output ?? 0 : null, runMs };
}

function resultOf(unit: SelectedUnit): keyof ModelRow['counts'] {
  const { outcome, firstReviewReworkAt } = unit.outcome;
  if (firstReviewReworkAt !== null) return 'reworked';
  return outcome ?? (unit.node.state === 'done' || unit.node.state === 'stopped' ? 'unjudged' : 'pending');
}

export function summarizeOwnerChoices<Choice>(units: Iterable<SelectedUnit>, pick: PickChoice<Choice>,
  available: (choice: Choice) => boolean, now: number) {
  const totals = { ...counts(), mixed: 0 }, pendingTasksWithoutChoice: string[] = [];
  const byChoice = new Map<string, { row: Row<Choice>; output: number[]; time: number[] }>();
  for (const unit of units) {
    const result = resultOf(unit);
    const { choices, missing } = choicesBefore(unit, pick);
    if (choices.size > 1) {
      totals.mixed++;
      if (result === 'pending') pendingTasksWithoutChoice.push(unit.node.id);
      continue;
    }
    const selection = choices.entries().next().value;
    if (missing || !selection) {
      totals[result === 'pending' ? 'pending' : 'unjudged']++;
      if (result === 'pending') pendingTasksWithoutChoice.push(unit.node.id);
      continue;
    }
    const [key, choice] = selection;
    let group = byChoice.get(key);
    if (!group) {
      group = { row: { choice, available: available(choice), counts: counts(), judgments: [], pendingTasks: [],
        medianCost: { outputTokens: null, runMs: null }, costSamples: { outputTokens: 0, runMs: 0 } }, output: [], time: [] };
      byChoice.set(key, group);
    }
    totals[result]++;
    group.row.counts[result]++;
    if (result === 'pending') group.row.pendingTasks.push(unit.node.id);
    if (result !== 'passed' && result !== 'reworked') continue;
    const { acceptedAt, firstReviewReworkAt, stoppedAt } = unit.outcome;
    const at = firstReviewReworkAt ?? acceptedAt!;
    const cost = costOf(unit.launches, now);
    group.row.judgments.push({ task: unit.node.id, result, at, cost });
    // The median compares completed work. An early judgment can be shown while its cost is still accumulating.
    if (acceptedAt === null && stoppedAt === null || unit.launches.some(run => run.live)) continue;
    if (cost.outputTokens !== null) group.output.push(cost.outputTokens);
    if (cost.runMs !== null) group.time.push(cost.runMs);
  }
  const rows: Row<Choice>[] = [];
  for (const [, { row, output, time }] of [...byChoice].sort(([a], [b]) => a.localeCompare(b))) {
    row.judgments.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || idOrder(b.task, a.task));
    row.judgments = row.judgments.slice(0, 5);
    row.pendingTasks.sort(idOrder);
    row.medianCost = { outputTokens: median(output), runMs: median(time) };
    row.costSamples = { outputTokens: output.length, runMs: time.length };
    rows.push(row);
  }
  return { counts: totals, pendingTasksWithoutChoice: pendingTasksWithoutChoice.sort(idOrder), rows };
}
