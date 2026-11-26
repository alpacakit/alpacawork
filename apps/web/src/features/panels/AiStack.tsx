import { useEffect, useRef, useState } from 'react';
import { AgentMark } from '@/components/ui/agent-mark';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { NativeSelect } from '@/components/ui/native-select';
import { Message } from '@/components/ui/message';
import { FieldError } from '@/components/ui/field';
import { useChoiceText } from '@/features/forms/choice-text';
import { cn } from '@/lib/utils';
import type { AgentDraft } from './agent-settings-draft';
import { coordinatorStart, startValues, moveRow, newStackRow, repeatedRow, rowChoices, stackIssues, withRowAgent, withRowValue, type StackIssue, type StackRowDraft } from './ai-stack-draft';

/** Which of config.yaml's two AI stacks a list edits: the one tasks run on (`aiStack`), or the input's (`coordinatorAiStack`). */
export type StackKind = 'tasks' | 'coordinator';
/** The id of each list's heading: the input's AI and the bar's limits open the settings onto theirs (openSettings' `focus`). */
export const stackHeadingId = (kind: StackKind) => `settings-ai-stack-${kind}`;
/** The heading each list is named by, where a refused save says which list it is. */
export const stackTitleKey = (kind: StackKind) => kind === 'tasks' ? 'agentSettings.aiStack.title' as const : 'agentSettings.coordinatorStack.title' as const;

/**
 * One AI stack: the rows its AIs run on, in order. The first is where they start (the default); when one stops on a
 * usage limit or capacity, the next takes over. Each row is an agent and a value of each of its choices; the same
 * agent may stand on several rows with other models. A row the agents' settings no longer run says so here, as the
 * settings change, and keeps the save back. Both stacks are this one list; only their words differ.
 */
/** `refusedRows`, `refused`: what a save refused, by row (its index) or for the list as a whole, beside what the list finds itself. */
export function AiStack({ kind, rows, agents, onChange, refusedRows, refused }: {
  kind: StackKind; rows: StackRowDraft[]; agents: AgentDraft[]; onChange: (rows: StackRowDraft[]) => void;
  refusedRows?: readonly (string | undefined)[]; refused?: string;
}) {
  const { t } = useTranslation('panels');
  const issues = stackIssues(rows, agents);
  const enabled = agents.filter(agent => agent.enabled !== false);
  const added = newStackRow(agents, rows, kind === 'coordinator' ? coordinatorStart : startValues);
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
    {/* Brought into view with room above it, so its edge stands clear of the tabs' rule. */}
    <section aria-labelledby={stackHeadingId(kind)} data-ai-stack={kind} className="min-w-0 scroll-mt-4 rounded-lg border border-line bg-raised">
      <div className="px-4 pt-4 pb-3 narrow:px-3">
        {/* Focusable by the screen alone: the input's AI opens the settings onto it. */}
        <h3 id={stackHeadingId(kind)} tabIndex={-1} className="text-base font-semibold">{t(stackTitleKey(kind))}</h3>
        <p className="mt-1 text-sm text-pretty text-muted [word-break:auto-phrase]">{t(kind === 'tasks' ? 'agentSettings.aiStack.lead' : 'agentSettings.coordinatorStack.lead')}</p>
      </div>
      {/* On a PC the rows share their columns, so each one's role is as wide as the longest, and the agents as the longest
          name they offer (up to a limit), and every agent and value starts on one line. */}
      <ol ref={list} aria-labelledby={stackHeadingId(kind)} className="m-0 grid list-none grid-cols-[max-content_fit-content(12rem)_minmax(0,1fr)_auto] p-0 narrow:block">
        {rows.map((row, index) => <StackRow key={row.id} row={row} index={index} count={rows.length} agents={agents} enabled={enabled}
          issues={issues.filter(issue => issue.rowId === row.id)} refused={refusedRows?.[index]} repeats={repeatedRow(rows, index, agents)}
          onChange={next => onChange(rows.map(was => was.id === row.id ? next : was))}
          onMove={by => onChange(moveRow(rows, index, by))}
          onRemove={() => onChange(rows.filter(was => was.id !== row.id))} />)}
      </ol>
      <div className="border-t border-line px-4 py-3 narrow:px-3">
        <Button type="button" variant="outline" disabled={!added} data-ai-stack-add onClick={() => { if (added) { onChange([...rows, added]); setFocusRow(added.id); } }}>
          {t(rows.length ? 'agentSettings.aiStack.add' : 'agentSettings.aiStack.addFirst')}</Button>
        {issues.some(issue => issue.kind === 'empty') && <FieldError className="mt-2">{t('agentSettings.aiStack.issue.empty')}</FieldError>}
        {refused && <FieldError className="mt-2">{refused}</FieldError>}
        {/* Only a request names an AI for a task; nothing names one for the input. */}
        {kind === 'tasks' && <p className="mt-3 text-sm text-pretty text-muted [word-break:auto-phrase]">{t('agentSettings.aiStack.namedOnly')}</p>}
      </div>
    </section>
  </div>;
}

function StackRow({ row, index, count, agents, enabled, issues, refused, repeats, onChange, onMove, onRemove }: {
  row: StackRowDraft; index: number; count: number; agents: AgentDraft[]; enabled: AgentDraft[]; issues: StackIssue[]; refused?: string;
  repeats: number | null; onChange: (row: StackRowDraft) => void; onMove: (by: -1 | 1) => void; onRemove: () => void;
}) {
  const { t } = useTranslation('panels');
  const text = useChoiceText();
  // A row is named by its role, which goes with its place: the controls and fields say it, the role shown is not read twice.
  const role = (at: number) => at === 0 ? t('agentSettings.aiStack.first') : t('agentSettings.aiStack.fallback', { n: at });
  const name = role(index);
  const agent = agents.find(each => each.name === row.agent);
  const listed = enabled.some(each => each.name === row.agent);
  const choices = agent ? rowChoices(agent, row.values) : [];
  const shown = (value: string | null) => value === null ? text(null) : value;
  const optionValue = (value: string | null) => value === null ? '-' : value;
  const issueText = (issue: StackIssue) => issue.kind === 'missing' ? t('agentSettings.aiStack.issue.missing', { agent: row.agent })
    : issue.kind === 'disabled' ? t('agentSettings.aiStack.issue.disabled', { agent: row.agent })
    : issue.kind === 'value' ? t('agentSettings.aiStack.issue.value', { row: text.row(issue.key), value: shown(issue.value), agent: row.agent }) : '';
  // One line on a PC: its role (the primary, or which fallback), its agent, two choices to a line in columns, and its
  // controls. On a phone the role and controls head the row, the agent and its choices go under them, one to a line.
  return <li data-ai-stack-row={row.agent} data-ai-stack-row-id={row.id} data-invalid={issues.length || refused ? '' : undefined} data-repeats={repeats === null ? undefined : repeats + 1}
    className="col-span-4 grid grid-cols-subgrid items-baseline gap-x-2 border-t border-line px-4 py-3 narrow:grid-cols-[minmax(0,1fr)_auto] narrow:gap-x-2 narrow:px-3">
    <span aria-hidden className={cn('whitespace-nowrap narrow:self-center', index === 0 ? 'font-semibold' : 'text-muted')}>{name}</span>
    {/* The agent's logo stands inside its box, before its name (a choice's own words cannot carry a drawing). */}
    <div className="relative min-w-28 narrow:col-span-2 narrow:row-start-2 narrow:mt-1">
    <AgentMark name={row.agent} className="pointer-events-none absolute top-1/2 left-2.5 z-1 -translate-y-1/2" />
    <NativeSelect variant="field" className="w-full pl-8 font-semibold" value={row.agent} aria-invalid={issues.some(issue => issue.kind !== 'value') || !!refused || undefined}
      aria-label={t('agentSettings.aiStack.agentFor', { role: name })}
      onChange={event => { const next = agents.find(each => each.name === event.target.value); if (next) onChange(withRowAgent(next, row)); }}>
      {!listed && <option value={row.agent}>{row.agent}</option>}
      {enabled.map(each => <option key={each.id} value={each.name}>{each.name}</option>)}
    </NativeSelect>
    </div>
    {choices.length > 0 && <div className="grid min-w-0 grid-cols-[max-content_minmax(0,9rem)_max-content_minmax(0,9rem)] items-baseline gap-x-2 gap-y-2 narrow:col-span-2 narrow:row-start-3 narrow:mt-2 narrow:grid-cols-[4.5rem_minmax(0,1fr)] narrow:gap-x-2">
      {choices.map((choice, at) => {
        const { value, refused } = choice;
        return <label key={choice.key} data-ai-stack-choice={choice.key} className="contents">
          <span className={cn('text-sm text-muted', at % 2 === 1 && 'ml-2 narrow:ml-0')}>{text.row(choice.key)}</span>
          <NativeSelect variant="field" className="w-full font-mono" value={optionValue(value)} aria-invalid={refused || undefined}
            aria-label={t('agentSettings.aiStack.valueFor', { role: name, row: text.row(choice.key) })}
            onChange={event => onChange(withRowValue(row, choice.key, event.target.value === '-' ? null : event.target.value))}>
            {refused && <option value={optionValue(value)}>{t('agentSettings.aiStack.notOffered', { value: shown(value) })}</option>}
            {choice.candidates.map(each => <option key={optionValue(each)} value={optionValue(each)}>{shown(each)}</option>)}
          </NativeSelect>
        </label>;
      })}
    </div>}
    <div className="col-start-4 row-start-1 flex min-h-control-md items-center self-start narrow:col-start-2">
      <Button type="button" variant="quiet" size="icon" disabled={index === 0} aria-label={t('agentSettings.aiStack.up', { role: name })} title={t('agentSettings.aiStack.up', { role: name })}
        onClick={() => onMove(-1)}><Icon name="up" className="size-4" /></Button>
      <Button type="button" variant="quiet" size="icon" disabled={index === count - 1} aria-label={t('agentSettings.aiStack.down', { role: name })} title={t('agentSettings.aiStack.down', { role: name })}
        onClick={() => onMove(1)}><Icon name="down" className="size-4" /></Button>
      <Button type="button" variant="quiet" size="icon" aria-label={t('agentSettings.aiStack.remove', { role: name })} title={t('agentSettings.aiStack.remove', { role: name })}
        onClick={onRemove}><Icon name="close" className="size-4" /></Button>
    </div>
    {(issues.length > 0 || refused || repeats !== null) && <div className="col-span-2 col-start-2 mt-2 flex flex-col gap-1 self-start narrow:col-start-1">
      {issues.map((issue, at) => <FieldError key={at}>{issueText(issue)}</FieldError>)}
      {refused && <FieldError>{refused}</FieldError>}
      {repeats !== null && <Message size="line" tone="info" quiet title={t('agentSettings.aiStack.repeated', { role: role(repeats) })} />}
    </div>}
  </li>;
}
