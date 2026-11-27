import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { AGENT_ADAPTERS } from '@alpacawork/contract/agent-adapters';
import { AgentMark } from '@/components/ui/agent-mark';
import { Button } from '@/components/ui/button';
import { Caret } from '@/components/ui/caret';
import { FieldError, FieldHint } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { SettingRow } from '@/components/settings/SettingRow';
import { AgentSettingsDisabled } from './agent-settings-editing';
import { cn } from '@/lib/utils';
import { AgentSettingsOptions } from './AgentSettingsOptions';
import { AddAgentControl, AgentDefaultMark, AgentExtraFields } from './AgentSettingsExtras';
import { AgentExecutableRow, AgentNoticeLine } from './AgentSettingsExecutable';
import { AgentContextRows, type ReportedContext } from './AgentSettingsContext';
import { agentDraftIssueText } from './agent-settings-issues';
import { agentOptionsVersion } from './agent-options-version';
import { draftAdapter, editDraftParam, followsDefaultParam, isDefaultParam, isOptionalDraftParam, resetDraftParam, unusedParamReason, type AgentDraft, type AgentDraftIssue, type AgentsDraft, type ParamRowDraft } from './agent-settings-draft';

export type AgentSettingsHandle = { focus: () => void };

function ParamRows({ agent, onChange, issues, nextId }: {
  agent: AgentDraft; onChange: (agent: AgentDraft) => void; issues: AgentDraftIssue[]; nextId: () => string;
}) {
  const { t } = useTranslation('panels');
  const id = useId();
  const adapter = draftAdapter(agent);
  const update = (row: ParamRowDraft) => onChange({ ...agent, params: agent.params.map(was => was.id === row.id ? row : was) });
  const rowErrors = (row: ParamRowDraft, field: 'key' | 'values') => issues.filter(issue => issue.rowId === row.id && issue.field === field).map(issue => agentDraftIssueText(issue, t, agent)).join('\n');
  return <SettingRow id={id} label={t('agentSettings.choices')} hint={t('agentSettings.choicesHint')} className="grid-cols-[10rem_minmax(0,1fr)] items-start narrow:grid-cols-1 narrow:gap-y-3">
    <div id={id} className="min-w-0">
      <div className="grid grid-cols-[8rem_minmax(0,1fr)_2rem] gap-2 narrow:grid-cols-[fit-content(5.5rem)_minmax(0,1fr)_2rem]">
        <div className="col-span-full grid grid-cols-subgrid text-sm text-muted">
          <span>{t('agentSettings.key')}</span><span className="col-span-2">{t('agentSettings.values')}</span>
        </div>
        {agent.params.map(row => {
        const fixed = row.originalKey !== undefined && isDefaultParam(agent, row.originalKey);
        // A default with no values (an adapter that suggests none) has nothing to follow or restore.
        const followable = fixed && !!adapter && (AGENT_ADAPTERS[adapter].defaultParams[row.key]?.length ?? 0) > 0;
        const unused = unusedParamReason(agent, row.key);
        const rowId = `${id}-${row.id}`;
        return <div key={row.id} className="col-span-full grid grid-cols-subgrid items-start">
          <div className="min-w-0">
            {fixed ? <label htmlFor={`${rowId}-values`} className="block px-2 py-2 font-mono">{row.key}</label>
              : <Input id={`${rowId}-key`} aria-label={t('agentSettings.key')} className="font-mono narrow:px-1 narrow:text-sm" aria-invalid={!!rowErrors(row, 'key')}
                aria-describedby={rowErrors(row, 'key') ? `${rowId}-key-error` : undefined} value={row.key} onChange={event => update(editDraftParam(row, { key: event.target.value }))} />}
            {rowErrors(row, 'key') && <FieldError id={`${rowId}-key-error`}>{rowErrors(row, 'key')}</FieldError>}
          </div>
          <div className={cn('min-w-0', fixed && 'col-span-2')}>
            <Textarea id={`${rowId}-values`} aria-label={t('agentSettings.paramValues', { key: row.key })} rows={1}
              placeholder={isOptionalDraftParam(agent, row.key) ? t('agentSettings.emptyOptional') : undefined}
              className="min-h-control-md resize-none [field-sizing:content]" aria-invalid={!!rowErrors(row, 'values')}
              aria-describedby={rowErrors(row, 'values') ? `${rowId}-values-error` : unused ? `${rowId}-unused` : undefined}
              value={row.values} onChange={event => update(editDraftParam(row, { values: event.target.value }))} />
            {rowErrors(row, 'values') && <FieldError id={`${rowId}-values-error`}>{rowErrors(row, 'values')}</FieldError>}
            {unused && <FieldHint id={`${rowId}-unused`} className="mt-1">{t(unused === 'adapter' ? 'agentSettings.unusedAdapter' : 'agentSettings.unusedOptions')}</FieldHint>}
            {followable && <AgentDefaultMark isDefault={followsDefaultParam(agent, row)} name={row.key} field={`${rowId}-values`}
              onRestore={() => onChange(resetDraftParam(agent, row.id))} />}
          </div>
          {!fixed && <Button type="button" variant="quiet" size="icon" className="narrow:self-end" aria-label={t('agentSettings.removeRow', { key: row.key })}
            onClick={() => onChange({ ...agent, params: agent.params.filter(was => was.id !== row.id) })}>×</Button>}
        </div>;
      })}
      </div>
      <Button type="button" variant="outline" className="mt-2" onClick={() => onChange({ ...agent, params: [...agent.params, { id: nextId(), key: '', values: '' }] })}>{t('agentSettings.addRow')}</Button>
      {issues.filter(issue => (issue.field === 'key' || issue.field === 'values') && !issue.rowId).map((issue, index) => <FieldError key={index}>{agentDraftIssueText(issue, t, agent)}</FieldError>)}
    </div>
  </SettingRow>;
}

function AgentSettingsCard({ agent, onChange, onRemove, issues, nextId, environmentFile, reportedContext, ref }: {
  agent: AgentDraft; onChange: (agent: AgentDraft) => void; onRemove: () => void;
  issues: AgentDraftIssue[]; nextId: () => string; environmentFile: string | undefined; reportedContext: ReportedContext;
  ref?: Ref<AgentSettingsHandle>;
}) {
  const { t } = useTranslation('panels');
  const id = useId();
  // Every card opens closed, so the section reads as a list of agents; a refused save opens the one with the problem.
  const [expanded, setExpanded] = useState(false);
  const section = useRef<HTMLElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  useImperativeHandle(ref, () => ({ focus() { setExpanded(true); setFocusRequest(value => value + 1); } }), []);
  useEffect(() => {
    if (!focusRequest || !expanded) return;
    // Wait until the disclosure and any containing form disclosure are visible.
    const frame = requestAnimationFrame(() => {
      const target = section.current?.querySelector<HTMLElement>('input[aria-invalid="true"], textarea[aria-invalid="true"]')
        ?? section.current?.querySelector<HTMLElement>('[data-slot="field-error"]');
      if (target) { if (!target.matches('input, textarea')) target.tabIndex = -1; target.focus(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, expanded]);
  const adapter = draftAdapter(agent);
  const version = agentOptionsVersion(agent);
  return <section ref={section} aria-labelledby={`${id}-heading`} data-agent-name={agent.name} className="min-w-0 rounded-lg border border-line bg-raised p-4 narrow:p-3">
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
      {/* Pressing the name opens the card too, like its caret button (which stays the keyboard's way in). */}
      <div onClick={() => setExpanded(value => !value)} className={cn('flex min-w-0 cursor-pointer flex-wrap items-center gap-2', agent.enabled === false && 'opacity-50')}>
        <h3 id={`${id}-heading`} className="flex items-center gap-1.5 text-base font-semibold [overflow-wrap:anywhere]"><AgentMark name={agent.name} kind={adapter ?? undefined} /><span className="cap-box">{agent.name}</span></h3>
        {adapter && adapter !== agent.name && <span className="whitespace-nowrap text-sm text-muted">{t('agentSettings.kind', { adapter })}</span>}
        {agent.options && <span className="rounded-full border border-warn px-2 py-0.5 text-sm text-warn">{t('agentSettings.edited')}</span>}
      </div>
      <div className="col-span-full row-start-2 min-w-0 empty:hidden"><AgentNoticeLine agent={agent} /></div>
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-2">
          <Switch id={`${id}-enabled`} checked={agent.enabled !== false} onCheckedChange={enabled => onChange({ ...agent, enabled })}
            aria-label={t('agentSettings.useAgent', { name: agent.name })} />
          <label htmlFor={`${id}-enabled`} className="text-sm">{t(agent.enabled === false ? 'agentSettings.disabled' : 'agentSettings.enabled')}</label>
        </div>
        <Button type="button" variant="quiet" size="icon" aria-expanded={expanded} aria-controls={`${id}-body`}
          aria-label={t(expanded ? 'agentSettings.collapse' : 'agentSettings.expand', { name: agent.name })} onClick={() => setExpanded(value => !value)}><Caret open={expanded} /></Button>
      </div>
    </div>
    {expanded && <div id={`${id}-body`} className="mt-5 space-y-5">
      {adapter && <p><a href={AGENT_ADAPTERS[adapter].referenceUrl} target="_blank" rel="noopener noreferrer" className="inline-link text-sm">{t('agentSettings.reference', { adapter })}</a></p>}
      <AgentExecutableRow agent={agent} onChange={onChange} issues={issues} />
      <ParamRows agent={agent} onChange={onChange} issues={issues} nextId={nextId} />
      <AgentContextRows agent={agent} onChange={onChange} issues={issues} reported={reportedContext} />
      {version.changed && <FieldHint>{t('agentSettings.defaultsChanged')}</FieldHint>}
      <AgentSettingsOptions agent={agent} onChange={onChange} issues={issues} base={version.base} />
      <AgentExtraFields agent={agent} onChange={onChange} issues={issues} environmentFile={environmentFile} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="text-error" onClick={onRemove}>{t('agentSettings.remove', { name: agent.name })}</Button>
      </div>
    </div>}
    {issues.filter(issue => issue.field === 'name' || issue.field === 'adapter' || issue.field === 'enabled' || issue.field === 'without').map((issue, index) => <FieldError key={index}>{agentDraftIssueText(issue, t, agent)}</FieldError>)}
    {!expanded && issues.some(issue => issue.rowId || issue.field === 'start' || issue.field === 'resume' || issue.field === 'base' || issue.field === 'env' || issue.field === 'command') &&
      <FieldError><Button type="button" variant="ref" onClick={() => setExpanded(true)}>{t('agentSettings.openErrors')}</Button></FieldError>}
  </section>;
}

/**
 * Controlled, API-free form. Its parent owns validation timing and saves the YAML after writeAgentsDraft succeeds.
 * `environmentFile` is where the server's environment file is, once its parent has read it: the form names it where a
 * variable's value has to come from.
 */
export function AgentSettings({ draft, onChange, issues = [], disabled = false, environmentFile, reportedContext, ref }: {
  draft: AgentsDraft; onChange: (draft: AgentsDraft) => void; issues?: AgentDraftIssue[]; disabled?: boolean; environmentFile?: string;
  /** What agents have reported of their models' limits, once the parent has read the settings. */
  reportedContext?: ReportedContext;
  ref?: Ref<AgentSettingsHandle>;
}) {
  const { t } = useTranslation('panels');
  const id = useId();
  const sequence = useRef(0);
  const cards = useRef(new Map<string, AgentSettingsHandle>());
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useImperativeHandle(ref, () => ({ focus() {
    const firstInvalid = draft.agents.find(agent => issues.some(issue => issue.agentId === agent.id));
    if (firstInvalid) cards.current.get(firstInvalid.id)?.focus();
    else fieldset.current?.querySelector<HTMLElement>('[data-slot="field-error"]')?.focus();
  } }), [draft.agents, issues]);
  const nextId = () => `${id}-${sequence.current++}`;
  const change = (updated: AgentsDraft) => { if (!disabled) onChange(updated); };
  return <AgentSettingsDisabled value={disabled}><fieldset ref={fieldset} disabled={disabled} className="min-w-0 border-0 p-0">
    <div className="flex flex-col gap-4">
      {draft.agents.map(agent => <AgentSettingsCard key={agent.id} agent={agent}
        ref={handle => { if (handle) cards.current.set(agent.id, handle); else cards.current.delete(agent.id); }}
        nextId={nextId} issues={issues.filter(issue => issue.agentId === agent.id)} environmentFile={environmentFile} reportedContext={reportedContext}
        onChange={updated => change({ ...draft, agents: draft.agents.map(was => was.id === agent.id ? updated : was) })}
        onRemove={() => change({ ...draft, agents: draft.agents.filter(was => was.id !== agent.id) })} />)}
      <AddAgentControl names={draft.agents.map(agent => agent.name)} nextId={nextId} environmentFile={environmentFile} onAdd={agent => change({ ...draft, agents: [...draft.agents, agent] })} />
      {issues.filter(issue => !issue.agentId).map((issue, index) => <FieldError key={index} tabIndex={-1}>{agentDraftIssueText(issue, t)}</FieldError>)}
    </div>
  </fieldset></AgentSettingsDisabled>;
}
