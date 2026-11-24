import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AGENT_ADAPTERS } from '@alpacawork/contract/agent-adapters';
import { resolveContextLimits, type ModelContext } from '@alpacawork/contract/agent-context';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SettingRow } from '@/components/settings/SettingRow';
import { useServerSettings } from '@/data/queries';
import { draftAdapter, type AgentDraft, type AgentDraftIssue } from './agent-settings-draft';
import { agentDraftIssueText } from './agent-settings-issues';

/* Hallmark · component: per-model context limits · genre: modern-minimal · theme: the app's own tokens (settings rows) */

const FIELDS = ['window', 'compact_at'] as const;

/** The draft's model candidates, or `-` (none chosen) when it lists none: the keys a person can write a limit for. */
export function contextModelKeys(agent: AgentDraft): string[] {
  const models = (agent.params.find(row => row.key === 'model')?.values ?? '').split(',').map(value => value.trim())
    .filter(value => value && value !== '-');
  return models.length ? models : ['-'];
}

/** A typed figure as the setting keeps it: digits only, nothing for an empty field (it falls back to the agent's or the shipped value). */
export function editContext(context: AgentDraft['context'], model: string, field: keyof ModelContext, typed: string): AgentDraft['context'] {
  const digits = typed.replace(/[^\d]/g, '');
  const value = digits === '' ? undefined : Number(digits);
  const { [field]: _old, ...rest } = context?.[model] ?? {};
  const next: ModelContext = value ? { ...rest, [field]: value } : rest;
  const { [model]: _was, ...others } = context ?? {};
  const all = Object.keys(next).length ? { ...others, [model]: next } : others;
  return Object.keys(all).length ? all : undefined;
}

/**
 * Each model's context window and where it compacts by itself, for the ring beside a working agent. An empty field
 * shows, faintly, what is used without it: the figure the agent reported, or the shipped one, and which; a typed figure
 * wins over both. A person fills here what an agent never says (Grok's window), or a model added since the release.
 */
export function AgentContextRows({ agent, onChange, issues }: {
  agent: AgentDraft; onChange: (agent: AgentDraft) => void; issues: AgentDraftIssue[];
}) {
  const { t, i18n } = useTranslation('panels');
  const id = useId();
  const reported = useServerSettings().data?.reportedContext;
  const adapter = draftAdapter(agent);
  if (!adapter) return null;
  const count = new Intl.NumberFormat(i18n.language);
  const errors = issues.filter(issue => issue.field === 'context');
  const keys = contextModelKeys(agent);
  return <SettingRow id={`${id}-0-window`} label={t('agentSettings.context.title')} className="grid-cols-[10rem_minmax(0,1fr)] items-start narrow:grid-cols-1 narrow:gap-y-2">
    <div className="min-w-0 space-y-2">
      <p className="m-0 text-sm text-muted">{t('agentSettings.context.hint')}</p>
      <div role="table" aria-label={t('agentSettings.context.title')} className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,9rem)] items-center gap-x-3 gap-y-2 narrow:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div role="row" className="contents text-xs text-muted">
          <span role="columnheader" className="narrow:hidden">{t('agentSettings.context.model')}</span>
          <span role="columnheader" className="narrow:hidden">{t('agentSettings.context.window')}</span>
          <span role="columnheader" className="narrow:hidden">{t('agentSettings.context.compactAt')}</span>
        </div>
        {keys.map((model, index) => {
          const shown = resolveContextLimits({ reported: reported?.[adapter]?.[model], default: AGENT_ADAPTERS[adapter].contextDefaults[model] });
          const hint = (field: typeof FIELDS[number]) => {
            const value = field === 'window' ? shown.windowTokens : shown.compactAtTokens;
            const from = field === 'window' ? shown.windowFrom : shown.compactAtFrom;
            return value === null ? t('agentSettings.context.none') : t('agentSettings.context.from', { value: count.format(value), source: t(`agentSettings.context.source.${from}`) });
          };
          const name = model === '-' ? t('agentSettings.context.noModel') : model;
          return <div role="row" key={model} data-context-model={model} className="contents">
            <span role="rowheader" className="min-w-0 truncate font-mono text-sm narrow:col-span-2" title={name}>{name}</span>
            {FIELDS.map(field => <label key={field} className="min-w-0">
              <span className="mb-1 hidden text-xs text-muted narrow:block">{t(field === 'window' ? 'agentSettings.context.window' : 'agentSettings.context.compactAt')}</span>
              <Input id={`${id}-${index}-${field}`} inputMode="numeric" className="tabular-nums" value={agent.context?.[model]?.[field]?.toString() ?? ''}
                placeholder={hint(field)} aria-label={`${name} ${t(field === 'window' ? 'agentSettings.context.window' : 'agentSettings.context.compactAt')}`}
                aria-invalid={errors.some(issue => issue.path?.includes(model)) || undefined}
                onChange={event => onChange({ ...agent, context: editContext(agent.context, model, field, event.target.value) })} />
            </label>)}
          </div>;
        })}
      </div>
      {errors.map((issue, index) => <FieldError key={index}>{agentDraftIssueText(issue, t, agent)}</FieldError>)}
    </div>
  </SettingRow>;
}
