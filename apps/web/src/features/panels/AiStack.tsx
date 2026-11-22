import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { NativeSelect } from '@/components/ui/native-select';
import { Message } from '@/components/ui/message';
import { FieldError } from '@/components/ui/field';
import { useChoiceText } from '@/features/forms/choice-text';
import { cn } from '@/lib/utils';
import type { AgentDraft } from './agent-settings-draft';
import { moveRow, newStackRow, repeatedRow, rowChoices, stackIssues, withRowAgent, withRowValue, type StackIssue, type StackRowDraft } from './ai-stack-draft';

/**
 * The AI stack: the rows owners and members run on, in order. The first is where they start (the default); when one
 * stops on a usage limit or capacity, the next takes over the same request. Each row is an agent and a value of each
 * of its choices; the same agent may stand on several rows with other models. A row the agents' settings no longer
 * run says so here, as the settings change, and keeps the save back.
 */
export function AiStack({ rows, agents, onChange }: { rows: StackRowDraft[]; agents: AgentDraft[]; onChange: (rows: StackRowDraft[]) => void }) {
  const { t } = useTranslation('panels');
  const id = useId();
  const issues = stackIssues(rows, agents);
  const enabled = agents.filter(agent => agent.enabled !== false);
  const added = newStackRow(agents, rows);
  // A row just added is edited from its first choice (its model), which takes the focus.
  const list = useRef<HTMLOListElement>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  useEffect(() => {
    if (!focusRow) return;
    const row = list.current?.querySelector<HTMLElement>(`[data-ai-stack-row-id="${focusRow}"]`);
    (row?.querySelector<HTMLElement>('[data-ai-stack-choice] select') ?? row?.querySelector<HTMLElement>('select'))?.focus();
    setFocusRow(null);
  }, [focusRow]);
  return <div className="flex flex-col gap-2">
    <section aria-labelledby={`${id}-title`} data-ai-stack className="min-w-0 rounded-lg border border-line bg-raised">
      <div className="px-4 pt-4 pb-3 narrow:px-3">
        <h3 id={`${id}-title`} className="text-base font-semibold">{t('agentSettings.aiStack.title')}</h3>
        <p className="mt-1 text-sm text-muted">{t('agentSettings.aiStack.lead')}</p>
      </div>
      <ol ref={list} aria-labelledby={`${id}-title`} className="m-0 list-none p-0">
        {rows.map((row, index) => <StackRow key={row.id} row={row} index={index} count={rows.length} agents={agents} enabled={enabled}
          issues={issues.filter(issue => issue.rowId === row.id)} repeats={repeatedRow(rows, index)}
          onChange={next => onChange(rows.map(was => was.id === row.id ? next : was))}
          onMove={by => onChange(moveRow(rows, index, by))}
          onRemove={() => onChange(rows.filter(was => was.id !== row.id))} />)}
      </ol>
      <div className="border-t border-line px-4 py-3 narrow:px-3">
        <Button type="button" variant="outline" disabled={!added} data-ai-stack-add onClick={() => { if (added) { onChange([...rows, added]); setFocusRow(added.id); } }}>
          {t('agentSettings.aiStack.add')}</Button>
        {issues.some(issue => issue.kind === 'empty') && <FieldError className="mt-2">{t('agentSettings.aiStack.issue.empty')}</FieldError>}
        <p className="mt-3 text-sm text-muted">{t('agentSettings.aiStack.namedOnly')}</p>
      </div>
    </section>
    <p className="text-sm text-muted">{t('agentSettings.aiStack.coordinatorNote')}</p>
  </div>;
}

function StackRow({ row, index, count, agents, enabled, issues, repeats, onChange, onMove, onRemove }: {
  row: StackRowDraft; index: number; count: number; agents: AgentDraft[]; enabled: AgentDraft[]; issues: StackIssue[];
  repeats: number | null; onChange: (row: StackRowDraft) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
}) {
  const { t } = useTranslation('panels');
  const text = useChoiceText();
  const n = index + 1;
  const agent = agents.find(each => each.name === row.agent);
  const listed = enabled.some(each => each.name === row.agent);
  const choices = agent ? rowChoices(agent, row.values) : [];
  const shown = (value: string | null) => value === null ? text(null) : value;
  const optionValue = (value: string | null) => value === null ? '-' : value;
  const issueText = (issue: StackIssue) => issue.kind === 'missing' ? t('agentSettings.aiStack.issue.missing', { agent: row.agent })
    : issue.kind === 'disabled' ? t('agentSettings.aiStack.issue.disabled', { agent: row.agent })
    : issue.kind === 'value' ? t('agentSettings.aiStack.issue.value', { row: text.row(issue.key), value: shown(issue.value), agent: row.agent }) : '';
  // One line on a PC: its number, its agent (the first marked as the default under it), two choices to a line in
  // columns, and its controls. On a phone the choices go under the agent and its controls, one to a line.
  return <li data-ai-stack-row={row.agent} data-ai-stack-row-id={row.id} data-invalid={issues.length ? '' : undefined}
    className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-line px-4 py-3 narrow:gap-x-2 narrow:px-3">
    <span aria-hidden className="flex min-h-control-md items-center justify-end font-mono tabular-nums text-muted">{n}</span>
    <div className="flex min-w-0 items-start gap-x-5 narrow:contents">
      <div className="flex w-32 shrink-0 flex-col items-start gap-1 narrow:col-start-2 narrow:row-start-1 narrow:w-full narrow:flex-row narrow:flex-wrap narrow:items-center narrow:gap-2">
        <NativeSelect variant="field" className="w-full font-semibold narrow:w-auto narrow:min-w-24 narrow:flex-1" value={row.agent} aria-invalid={issues.some(issue => issue.kind !== 'value') || undefined}
          aria-label={t('agentSettings.aiStack.agentFor', { n })}
          onChange={event => { const next = agents.find(each => each.name === event.target.value); if (next) onChange(withRowAgent(next, row)); }}>
          {!listed && <option value={row.agent}>{row.agent}</option>}
          {enabled.map(each => <option key={each.id} value={each.name}>{each.name}</option>)}
        </NativeSelect>
        {index === 0 && <span data-ai-stack-first className="shrink-0 whitespace-nowrap rounded-full border border-line px-2 text-sm text-muted">{t('agentSettings.aiStack.first')}</span>}
      </div>
      {choices.length > 0 && <div className="grid min-w-0 flex-1 grid-cols-[max-content_minmax(0,9rem)_max-content_minmax(0,9rem)] items-center gap-x-3 gap-y-2 narrow:col-span-2 narrow:col-start-2 narrow:row-start-2 narrow:mt-2 narrow:grid-cols-[4.5rem_minmax(0,1fr)] narrow:gap-x-2">
        {choices.map((choice, at) => {
          const value = Object.hasOwn(row.values, choice.key) ? row.values[choice.key]! : choice.values[0]!;
          const offered = choice.values.includes(value);
          return <label key={choice.key} data-ai-stack-choice={choice.key} className="contents">
            <span className={cn('text-sm text-muted', at % 2 === 1 && 'ml-2 narrow:ml-0')}>{text.row(choice.key)}</span>
            <NativeSelect variant="field" className="w-full font-mono" value={optionValue(value)} aria-invalid={!offered || undefined}
              aria-label={t('agentSettings.aiStack.valueFor', { n, row: text.row(choice.key) })}
              onChange={event => agent && onChange(withRowValue(agent, row, choice.key, event.target.value === '-' ? null : event.target.value))}>
              {!offered && <option value={optionValue(value)}>{t('agentSettings.aiStack.notOffered', { value: shown(value) })}</option>}
              {choice.values.map(each => <option key={optionValue(each)} value={optionValue(each)}>{shown(each)}</option>)}
            </NativeSelect>
          </label>;
        })}
      </div>}
    </div>
    <div className="col-start-3 row-start-1 flex items-center">
      <Button type="button" variant="quiet" size="icon" disabled={index === 0} aria-label={t('agentSettings.aiStack.up', { n })} title={t('agentSettings.aiStack.up', { n })}
        onClick={() => onMove(-1)}><Icon name="up" className="size-4" /></Button>
      <Button type="button" variant="quiet" size="icon" disabled={index === count - 1} aria-label={t('agentSettings.aiStack.down', { n })} title={t('agentSettings.aiStack.down', { n })}
        onClick={() => onMove(1)}><Icon name="down" className="size-4" /></Button>
      <Button type="button" variant="quiet" size="icon" disabled={count === 1} aria-label={t('agentSettings.aiStack.remove', { n })} title={t('agentSettings.aiStack.remove', { n })}
        onClick={onRemove}><Icon name="close" className="size-4" /></Button>
    </div>
    {(issues.length > 0 || repeats !== null) && <div className="col-span-2 col-start-2 mt-2 flex flex-col gap-1">
      {issues.map((issue, at) => <FieldError key={at}>{issueText(issue)}</FieldError>)}
      {repeats !== null && <Message size="line" tone="info" quiet title={t('agentSettings.aiStack.repeated', { n: repeats + 1 })} />}
    </div>}
  </li>;
}
