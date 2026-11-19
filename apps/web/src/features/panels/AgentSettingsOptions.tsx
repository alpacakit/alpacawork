import { Fragment, useId, useState } from 'react';
import { Message } from "@/components/ui/message";
import { useTranslation } from 'react-i18next';
import { parseLaunchOptions, InvalidLaunchOptions, type OptionWord } from '@alpacawork/contract/launch-options';
import { AGENT_ADAPTERS, LAUNCH_MODES, type LaunchMode } from '@alpacawork/contract/agent-adapters';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FieldError } from '@/components/ui/field';
import { Dialog, DialogContent, DialogHeading, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { AgentSettingsLock } from './AgentSettingsLock';
import { SettingRow } from '@/components/settings/SettingRow';
import { useAgentSettingsDisabled } from './agent-settings-editing';
import { cn } from '@/lib/utils';
import { agentDraftIssueText } from './agent-settings-issues';
import { optionPartText } from './agent-options-display';
import { beginDraftOptionsEdit, draftAdapter, draftOptions, resetDraftOptions, updateDraftOptions,
  type AgentDraft, type AgentDraftIssue } from './agent-settings-draft';

function OptionWordView({ word }: { word: OptionWord }) {
  return <>{word.parts.map((part, index) => <Fragment key={index}>{part.kind === 'literal' ? optionPartText(part)
    : <span className={part.kind === 'selection' ? 'font-semibold text-option-param' : 'font-semibold text-soft'}>{`{${part.name}}`}</span>}</Fragment>)}</>;
}
/** Pair a flag and its argument using parsed words; optional groups stay together too. */
export function LaunchOptionsText({ source }: { source: string }) {
  try {
    const ast = parseLaunchOptions(source);
    const chunks = [];
    for (let index = 0; index < ast.length; index++) {
      const node = ast[index]!;
      if (node.kind === 'group') {
        chunks.push(<span key={index} className="inline-block whitespace-nowrap"><span className="text-soft">[</span>
          {node.words.map((word, index) => <Fragment key={index}>{index > 0 && ' '}<OptionWordView word={word} /></Fragment>)}
          <span className="text-soft">]</span></span>);
      } else {
        const next = ast[index + 1];
        const text = node.parts.map(part => part.kind === 'literal' ? part.value : `{${part.name}}`).join('');
        const nextText = next?.kind === 'word' ? next.parts.map(part => part.kind === 'literal' ? part.value : `{${part.name}}`).join('') : undefined;
        const pair = text.startsWith('-') && text !== '--' && next?.kind === 'word' && !nextText?.startsWith('-');
        chunks.push(<span key={index} className="inline-block whitespace-nowrap"><OptionWordView word={node} />
          {pair && <> <OptionWordView word={next} /></>}</span>);
        if (pair) index++;
      }
    }
    return <>{chunks.map((chunk, index) => <Fragment key={index}>{index > 0 && ' '}{chunk}</Fragment>)}</>;
  } catch (error) {
    if (!(error instanceof InvalidLaunchOptions)) throw error;
    return <span className="whitespace-pre-wrap">{source}</span>;
  }
}

export function LockedAgentPrefix({ agent }: { agent: AgentDraft }) {
  const { t } = useTranslation('panels');
  const adapter = draftAdapter(agent);
  if (!adapter) return null;
  return <AgentSettingsLock explanation={t('agentSettings.locked')}>{AGENT_ADAPTERS[adapter].prefix.join(' ')}</AgentSettingsLock>;
}

export function AgentSettingsOptions({ agent, onChange, issues, base }: {
  agent: AgentDraft; onChange: (agent: AgentDraft) => void; issues: AgentDraftIssue[]; base?: string;
}) {
  const { t } = useTranslation('panels');
  const disabled = useAgentSettingsDisabled();
  const [confirmReset, setConfirmReset] = useState(false);
  const id = useId();
  const options = draftOptions(agent);
  const modeLabels = { start: t('agentSettings.start'), resume: t('agentSettings.resume') };
  if (!options) return null;
  const modeErrors = (mode: LaunchMode) => issues.filter(issue => issue.field === mode).map(issue => agentDraftIssueText(issue, t, agent)).join('\n');
  return <SettingRow id={id} label={t('agentSettings.launchOptions')}
    className="grid-cols-[10rem_minmax(0,1fr)] items-start narrow:grid-cols-1 narrow:gap-y-3">
    <div id={id} className="min-w-0 space-y-2">
      {agent.options && <Message size="line" tone="caution" title={t('agentSettings.editedWarning')}
        action={{ label: t('agentSettings.reset'), run: () => setConfirmReset(true) }} />}
      {LAUNCH_MODES.map(mode => <div key={mode} className="min-w-0">
        <label htmlFor={`${id}-${mode}`} className="mb-1 block text-sm text-muted">{modeLabels[mode]}</label>
        {agent.options ? <div className="space-y-2 rounded-sm border border-ink bg-lit p-3">
          <code className="text-sm"><LockedAgentPrefix agent={agent} /></code>
          <Textarea id={`${id}-${mode}`} aria-invalid={!!modeErrors(mode)} aria-describedby={modeErrors(mode) ? `${id}-${mode}-error` : undefined}
            className="min-h-0 resize-none border-0 bg-transparent font-mono text-base [field-sizing:content]" rows={1} value={options[mode]}
            onChange={event => onChange(updateDraftOptions(agent, { ...agent.options!, [mode]: event.target.value }))} />
        </div> : <div id={`${id}-${mode}`} className={cn('min-w-0 overflow-x-auto rounded-sm border p-3 font-mono text-base', agent.options ? 'border-ink bg-lit' : 'border-line bg-well')}>
          <LockedAgentPrefix agent={agent} />{' '}<LaunchOptionsText source={options[mode]} />
        </div>}
        {modeErrors(mode) && <FieldError id={`${id}-${mode}-error`}>{modeErrors(mode)}</FieldError>}
      </div>)}
      {issues.filter(issue => issue.field === 'base' || issue.field === 'options').map((issue, index) =>
        <FieldError key={index}>{agentDraftIssueText(issue, t, agent)}</FieldError>)}
      {!agent.options && <div className="flex justify-end"><Button type="button" variant="outline"
        onClick={() => onChange(beginDraftOptionsEdit(agent, base))}>{t('agentSettings.editAdvanced')}</Button></div>}
    </div>
    <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
      <DialogContent><DialogHeading title={t('agentSettings.resetTitle', { name: agent.name })} />
        <DialogBody><p>{t('agentSettings.resetDescription')}</p><DialogFooter>
          <Button type="button" variant="outline" onClick={() => setConfirmReset(false)}>{t('agentSettings.cancel')}</Button>
          <Button type="button" disabled={disabled} onClick={() => { onChange(resetDraftOptions(agent)); setConfirmReset(false); }}>{t('agentSettings.reset')}</Button>
        </DialogFooter></DialogBody>
      </DialogContent>
    </Dialog>
  </SettingRow>;
}
