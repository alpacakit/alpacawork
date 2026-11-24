import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AGENT_ADAPTERS } from '@alpacawork/contract/agent-adapters';
import { resolveContextLimits } from '@alpacawork/contract/agent-context';
import type { ServerSettings } from '@alpacawork/contract';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/settings/SettingRow';
import { draftAdapter, type AgentDraft, type AgentDraftIssue } from './agent-settings-draft';
import { agentDraftIssueText } from './agent-settings-issues';

/* Hallmark · component: per-model context windows · genre: modern-minimal · theme: the app's own tokens (settings rows) */

/** What agents have reported of their models' windows, as the settings read gives it (its parent reads it). */
export type ReportedContext = ServerSettings['reportedContext'];

/**
 * The models a window can be written for: the draft's model candidates (`-` among them when a Run may choose none, and
 * alone when it lists none), then any model a window is still written for that the candidates no longer list, so it can
 * be cleared.
 */
export function contextModelKeys(agent: AgentDraft): string[] {
  const listed = (agent.params.find(row => row.key === 'model')?.values ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const candidates = listed.length ? [...listed.filter(value => value !== '-'), ...listed.includes('-') ? ['-'] : []] : ['-'];
  return [...candidates, ...Object.keys(agent.context ?? {}).filter(model => !candidates.includes(model))];
}

/** A typed window as the setting keeps it: its digits; nothing for an empty field (it falls back to the reported or shipped one). */
export function editContext(context: AgentDraft['context'], model: string, typed: string): AgentDraft['context'] {
  const digits = typed.replace(/[^\d]/g, '');
  const { [model]: _was, ...others } = context ?? {};
  const all = digits && Number(digits) > 0 ? { ...others, [model]: { window: Number(digits) } } : others;
  return Object.keys(all).length ? all : undefined;
}

/**
 * Each model's context window: the 100% of the ring beside a working agent in a task's detail. An empty field shows,
 * faintly, what is used without it (the window the agent reported, or the shipped one, and which); a typed window wins
 * over both. A person fills here what an agent never says (Grok's window), or a model added since the release.
 */
export function AgentContextRows({ agent, onChange, issues, reported }: {
  agent: AgentDraft; onChange: (agent: AgentDraft) => void; issues: AgentDraftIssue[]; reported: ReportedContext | undefined;
}) {
  const { t, i18n } = useTranslation('panels');
  const id = useId();
  // The field being typed in shows its bare digits, so the caret stays where it is; the others show grouped figures.
  const [typing, setTyping] = useState<string | null>(null);
  const adapter = draftAdapter(agent);
  if (!adapter) return null;
  const count = new Intl.NumberFormat(i18n.language);
  const errors = issues.filter(issue => issue.field === 'context');
  const candidates = contextModelKeys(agent);
  return <SettingRow id={`${id}-0`} label={t('agentSettings.context.title')} className="grid-cols-[10rem_minmax(0,1fr)] items-start narrow:grid-cols-1 narrow:gap-y-2">
    <div className="min-w-0 space-y-3">
      <p className="m-0 text-sm text-muted">{t('agentSettings.context.hint')}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,12rem)] items-center gap-x-3 gap-y-2">
        {candidates.map((model, index) => {
          const shown = resolveContextLimits({ reported: reported?.[adapter]?.[model], default: AGENT_ADAPTERS[adapter].contextDefaults[model] });
          const name = model === '-' ? t('agentSettings.context.noModel') : model;
          const written = agent.context?.[model]?.window;
          return <label key={model} data-context-model={model} className="contents">
            <span className="min-w-0 truncate font-mono text-sm" title={name}>{name}</span>
            <Input id={`${id}-${index}`} inputMode="numeric" className="text-right tabular-nums" value={written === undefined ? '' : typing === model ? String(written) : count.format(written)}
              onFocus={() => setTyping(model)} onBlur={() => setTyping(null)}
              placeholder={shown.windowTokens === null ? t('agentSettings.context.unset')
                : t('agentSettings.context.from', { value: count.format(shown.windowTokens), source: t(`agentSettings.context.source.${shown.windowFrom}`) })}
              aria-label={t('agentSettings.context.windowOf', { model: name })} aria-invalid={errors.some(issue => issue.path?.includes(model)) || undefined}
              onChange={event => onChange({ ...agent, context: editContext(agent.context, model, event.target.value) })} />
          </label>;
        })}
      </div>
      {errors.map((issue, index) => <FieldError key={index}>{agentDraftIssueText(issue, t, agent)}</FieldError>)}
    </div>
  </SettingRow>;
}
