import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { AddAgentGuideLines } from './AgentSettingsExecutable';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError } from '@/components/ui/field';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { SettingRow } from '@/components/settings/SettingRow';
import { useAgentSettingsDisabled } from './agent-settings-editing';
import { draftAdapter, editDraftEnv, followsDefaultEnv, newAgentDraft, resetDraftEnv, validateAgentsDraft, type AgentDraft, type AgentDraftIssue } from './agent-settings-draft';
import { agentDraftIssueText } from './agent-settings-issues';
import { AgentSettingsExplained, AgentSettingsLock } from './AgentSettingsLock';

/** The default agent's badge: the one placements start on. Hover or tap explains it. */
export function AgentDefaultBadge() {
  const { t } = useTranslation('panels');
  return <AgentSettingsExplained explanation={t('agentSettings.default.explanation')}
    className="rounded-full border border-line px-2 py-0.5 text-sm text-muted">{t('agentSettings.default.label')}</AgentSettingsExplained>;
}
/** Whether a field still follows the adapter's default, or a way back to it. Both share one line, so typing that
 * switches between them leaves the field where it is; the restore returns focus to the field it changed. */
export function AgentDefaultMark({ isDefault, name, field, onRestore }: {
  isDefault: boolean; name: string; field: string; onRestore: () => void;
}) {
  const { t } = useTranslation('panels');
  // On a phone the restore is a fingertip's height and stands clear of the fields around it.
  return <div className="mt-1 flex min-h-6 items-center narrow:mt-2 narrow:mb-1 narrow:min-h-control-sm">
    {isDefault ? <AgentSettingsExplained explanation={t('agentSettings.followDefault.explanation')}
      className="rounded-full border border-line px-2 text-sm text-muted">{t('agentSettings.followDefault.label')}</AgentSettingsExplained>
      : <Button type="button" variant="ref" className="text-sm narrow:min-h-control-sm narrow:pr-4" aria-label={t('agentSettings.restoreDefaultFor', { name })}
        onClick={() => { onRestore(); document.getElementById(field)?.focus(); }}>{t('agentSettings.restoreDefault')}</Button>}
  </div>;
}
export function AgentExtraFields({ agent, onChange, issues, environmentFile }: {
  agent: AgentDraft; onChange: (agent: AgentDraft) => void; issues: AgentDraftIssue[]; environmentFile: string | undefined;
}) {
  const { t } = useTranslation('panels');
  const id = useId();
  const adapter = draftAdapter(agent);
  return <SettingRow id={id} label={t('agentSettings.envNames')} className="grid-cols-[10rem_minmax(0,1fr)] items-start narrow:grid-cols-1 narrow:gap-y-2">
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="block text-sm text-muted">{environmentFile ? t('agentSettings.envHintFile', { path: environmentFile }) : t('agentSettings.envHint')}</label>
      {adapter && AGENT_ADAPTERS[adapter].fixedEnv.length > 0 && <div className="flex flex-wrap gap-1 font-mono text-sm">
        {AGENT_ADAPTERS[adapter].fixedEnv.map(name => <AgentSettingsLock key={name} explanation={t('agentSettings.fixedEnv', { name, adapter })}>{name}</AgentSettingsLock>)}
      </div>}
      <Input id={id} className="font-mono" value={agent.env?.join(', ') ?? ''} placeholder={t('agentSettings.envPlaceholder')} aria-invalid={issues.some(issue => issue.field === 'env')}
        aria-describedby={issues.some(issue => issue.field === 'env') ? `${id}-error` : undefined}
        onChange={event => onChange(editDraftEnv(agent, event.target.value === '' ? [] : event.target.value.split(',').map(name => name.trim())))} />
      {issues.some(issue => issue.field === 'env') && <FieldError id={`${id}-error`}>{issues.filter(issue => issue.field === 'env').map(issue => agentDraftIssueText(issue, t, agent)).join('\n')}</FieldError>}
      {adapter && AGENT_ADAPTERS[adapter].defaultEnv.length > 0 && <AgentDefaultMark isDefault={followsDefaultEnv(agent)}
        name={t('agentSettings.envNames')} field={id} onRestore={() => onChange(resetDraftEnv(agent))} />}
    </div>
  </SettingRow>;
}
export function AddAgentControl({ onAdd, nextId, names, environmentFile }: {
  onAdd: (agent: AgentDraft) => void; nextId: () => string; names: string[]; environmentFile: string | undefined;
}) {
  const { t } = useTranslation('panels');
  const [open, setOpen] = useState(false);
  const [adapter, setAdapter] = useState<BuiltinAdapterId>(BUILTIN_ADAPTER_IDS[0]!);
  const [name, setName] = useState('');
  const [issues, setIssues] = useState<AgentDraftIssue[]>([]);
  const id = useId();
  const disabled = useAgentSettingsDisabled();
  const duplicate = names.includes(name);
  const choose = (adapter: BuiltinAdapterId) => { setAdapter(adapter); setName(names.includes(adapter) ? '' : adapter); setIssues([]); };
  return <Popover open={open} onOpenChange={shown => { if (shown) choose(BUILTIN_ADAPTER_IDS.find(id => !names.includes(id)) ?? adapter); setOpen(shown); }}>
    <PopoverTrigger asChild><Button type="button" variant="outline" className="self-start">{t('agentSettings.addAgent')}</Button></PopoverTrigger>
    <PopoverContent side="top" align="start" className="w-96 space-y-3" style={{ animation: 'none' }} aria-label={t('agentSettings.addAgent')}>
      <fieldset disabled={disabled} className="space-y-3 border-0 p-0">
      <div><p className="mb-2 text-sm text-muted">{t('agentSettings.adapter')}</p><div className="grid grid-cols-3 gap-1">
        {BUILTIN_ADAPTER_IDS.map(id => <Button type="button" variant={id === adapter ? 'default' : 'outline'} key={id}
          className="w-full font-mono" aria-pressed={id === adapter} onClick={() => choose(id)}>{id}</Button>)}
      </div>
      <AddAgentGuideLines adapter={adapter} environmentFile={environmentFile} /></div>
      <div><label htmlFor={id} className="mb-1 block text-sm text-muted">{t('agentSettings.name')}</label><div className="flex items-center gap-2">
        <Input id={id} className="min-w-0 flex-1" value={name} aria-invalid={duplicate || issues.length > 0}
          aria-describedby={duplicate || issues.length ? `${id}-error` : undefined} onChange={event => { setName(event.target.value); setIssues([]); }} />
        <Button type="button" disabled={name.trim() === '' || duplicate} onClick={() => {
          const errors = validateAgentsDraft({ source: '{}', agents: [newAgentDraft(name, adapter, 'new-agent')] });
          if (errors.length) { setIssues(errors); return; }
          onAdd(newAgentDraft(name, adapter, nextId())); setIssues([]); setOpen(false);
        }}>{t('agentSettings.add')}</Button>
      </div></div>
      {(duplicate || issues.length > 0) && <div id={`${id}-error`}>
        {duplicate ? <FieldError>{t('agentSettings.duplicateName', { name })}</FieldError> : issues.map((issue, index) => <FieldError key={index}>{agentDraftIssueText(issue, t, newAgentDraft(name, adapter, 'new-agent'))}</FieldError>)}
      </div>}
      </fieldset>
    </PopoverContent>
  </Popover>;
}
