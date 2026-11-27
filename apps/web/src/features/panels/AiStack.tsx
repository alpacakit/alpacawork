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
  // Where the focus goes after a change takes away what held it: a row just added is edited from its first choice (its
  // model); a row moved keeps the focus on its controls (the other arrow, once one end leaves none); a row removed hands
  // it to the next row's controls, or to the add button when none is left.
  const list = useRef<HTMLOListElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const [focus, setFocus] = useState<{ row: string | null; part: 'choice' | 'control' } | null>(null);
  useEffect(() => {
    if (!focus) return;
    setFocus(null);
    const row = focus.row === null ? null : list.current?.querySelector<HTMLElement>(`[data-ai-stack-row-id="${focus.row}"]`);
    if (!row) { add.current?.focus(); return; }
    if (focus.part === 'choice') (row.querySelector<HTMLElement>('[data-ai-stack-choice] select') ?? row.querySelector<HTMLElement>('select'))?.focus();
    // A control the move made unusable still holds the focus for a moment (the other row moved past it): that is lost too.
    else if (!row.contains(document.activeElement) || (document.activeElement as HTMLButtonElement).disabled)
      row.querySelector<HTMLElement>('[data-ai-stack-controls] button:not(:disabled)')?.focus();
  }, [focus]);
  return <div className="flex flex-col gap-2">
    {/* Brought into view with room above it, so its edge stands clear of the tabs' rule. */}
    <section aria-labelledby={stackHeadingId(kind)} data-ai-stack={kind} className="@container/ai-stack min-w-0 scroll-mt-4 rounded-lg border border-line bg-raised">
      <div className="px-4 pt-4 pb-3 narrow:px-3">
        {/* Focusable by the screen alone: the input's AI opens the settings onto it. */}
        <h3 id={stackHeadingId(kind)} tabIndex={-1} className="text-base font-semibold">{t(stackTitleKey(kind))}</h3>
        <p className="mt-1 text-sm text-pretty text-muted [word-break:auto-phrase]">{t(kind === 'tasks' ? 'agentSettings.aiStack.lead' : 'agentSettings.coordinatorStack.lead')}</p>
      </div>
      <ol ref={list} aria-labelledby={stackHeadingId(kind)} className="m-0 list-none p-0">
        {rows.map((row, index) => <StackRow key={row.id} row={row} index={index} count={rows.length} agents={agents} enabled={enabled}
          issues={issues.filter(issue => issue.rowId === row.id)} refused={refusedRows?.[index]} repeats={repeatedRow(rows, index, agents)}
          onChange={next => onChange(rows.map(was => was.id === row.id ? next : was))}
          onMove={by => { onChange(moveRow(rows, index, by)); setFocus({ row: row.id, part: 'control' }); }}
          onRemove={() => { onChange(rows.filter(was => was.id !== row.id)); setFocus({ row: (rows[index + 1] ?? rows[index - 1])?.id ?? null, part: 'control' }); }} />)}
      </ol>
      <div className="border-t border-line px-4 py-3 narrow:px-3">
        <Button ref={add} type="button" variant="outline" disabled={!added} data-ai-stack-add onClick={() => { if (added) { onChange([...rows, added]); setFocus({ row: added.id, part: 'choice' }); } }}>
          {t(rows.length ? 'agentSettings.aiStack.add' : 'agentSettings.aiStack.addFirst')}</Button>
        {issues.some(issue => issue.kind === 'empty') && <FieldError className="mt-2">{t('agentSettings.aiStack.issue.empty')}</FieldError>}
        {refused && <FieldError className="mt-2">{refused}</FieldError>}
        {/* Only a request names an AI for a task; nothing names one for the input. */}
        {kind === 'tasks' && <p className="mt-3 text-sm text-pretty text-muted [word-break:auto-phrase]">{t('agentSettings.aiStack.namedOnly')}</p>}
      </div>
    </section>
  </div>;
}

/**
 * One AI in the order: its place (the primary, or which fallback), the AI itself — its agent and the values it runs with,
 * on one line, each value named inside its own box as wide as what it holds — and its controls, at the end of the line.
 * Values follow the agent when the line is full. In a list too narrow for that (Settings beside its side list in a small
 * window, a phone) the place and the controls head each row and the AI takes the whole width under them, its values under
 * its agent, so every row keeps one shape. A move the row cannot make is not offered; its room is kept, so the controls
 * line up. What is wrong with the row is said under the AI, and a refused value's box is marked.
 */
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
  const move = (by: -1 | 1, can: boolean) => {
    const label = t(by < 0 ? 'agentSettings.aiStack.up' : 'agentSettings.aiStack.down', { role: name });
    return <Button type="button" variant="quiet" size="icon" disabled={!can} aria-label={label} title={label} className="disabled:invisible"
      onClick={() => onMove(by)}><Icon name={by < 0 ? 'up' : 'down'} className="size-4" /></Button>;
  };
  return <li data-ai-stack-row={row.agent} data-ai-stack-row-id={row.id} data-invalid={issues.length || refused ? '' : undefined} data-repeats={repeats === null ? undefined : repeats + 1}
    className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-line px-4 py-2.5 narrow:px-3">
    <span aria-hidden className={cn('flex h-control-md min-w-12 flex-none items-center whitespace-nowrap @max-[36.5rem]/ai-stack:flex-1', index === 0 ? 'font-semibold' : 'text-muted')}>{name}</span>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5 @max-[36.5rem]/ai-stack:order-last @max-[36.5rem]/ai-stack:basis-full">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {/* The agent's logo stands inside its box, before its name (a choice's own words cannot carry a drawing). */}
        <div className="relative max-w-full @max-[36.5rem]/ai-stack:basis-full">
          <AgentMark name={row.agent} className="pointer-events-none absolute top-1/2 left-2.5 z-1 size-4 -translate-y-1/2" />
          <NativeSelect variant="field" className="w-auto border-line bg-transparent pr-1.5 pl-[1.8rem] font-semibold [field-sizing:content] hover:border-lit-line"
            value={row.agent} aria-invalid={issues.some(issue => issue.kind !== 'value') || !!refused || undefined}
            aria-label={t('agentSettings.aiStack.agentFor', { role: name })}
            onChange={event => { const next = agents.find(each => each.name === event.target.value); if (next) onChange(withRowAgent(next, row)); }}>
            {!listed && <option value={row.agent}>{row.agent}</option>}
            {enabled.map(each => <option key={each.id} value={each.name}>{each.name}</option>)}
          </NativeSelect>
        </div>
        {/* Each value is named by its key as the agent's settings write it, the same for every agent. */}
        {choices.map(({ key, value, refused, candidates }) => <label key={key} data-ai-stack-choice={key}
                    // The box is the control: the keyboard's mark is drawn round it, not round the select inside.
          className={cn('flex h-control-md max-w-full min-w-0 items-center rounded-sm border border-line hover:border-lit-line has-[:focus-visible]:[outline:1px_solid_var(--muted)] has-[:focus-visible]:[outline-offset:2px]', refused && 'border-warn hover:border-warn')}>
          <span className="ps-2.5 font-mono text-xs text-soft">{key}</span>
          <NativeSelect className={cn('h-full min-h-0 min-w-0 border-0 bg-transparent ps-1.5 pe-1.5 font-mono [field-sizing:content] focus-visible:outline-none narrow:text-md', value === null && 'text-soft')}
            value={optionValue(value)} aria-invalid={refused || undefined} aria-label={t('agentSettings.aiStack.valueFor', { role: name, row: text.row(key) })}
            onChange={event => onChange(withRowValue(row, key, event.target.value === '-' ? null : event.target.value))}>
            {/* A refused value is still shown as it is written; the box's mark and the line under the AI say why. */}
            {refused && <option value={optionValue(value)}>{shown(value)}</option>}
            {candidates.map(each => <option key={optionValue(each)} value={optionValue(each)}>{shown(each)}</option>)}
          </NativeSelect>
        </label>)}
      </div>
      {(issues.length > 0 || refused || repeats !== null) && <div className="flex flex-col gap-1">
        {issues.map((issue, at) => <FieldError key={at}>{issueText(issue)}</FieldError>)}
        {refused && <FieldError>{refused}</FieldError>}
        {repeats !== null && <Message size="line" tone="info" quiet title={t('agentSettings.aiStack.repeated', { role: role(repeats) })} />}
      </div>}
    </div>
    {/* Moving is kept apart from removing, which ends the row. */}
    <div data-ai-stack-controls className="flex h-control-md flex-none items-center">
      {move(-1, index > 0)}{move(1, index < count - 1)}
      <Button type="button" variant="quiet" size="icon" className="ms-2" aria-label={t('agentSettings.aiStack.remove', { role: name })} title={t('agentSettings.aiStack.remove', { role: name })}
        onClick={onRemove}><Icon name="close" className="size-4" /></Button>
    </div>
  </li>;
}
