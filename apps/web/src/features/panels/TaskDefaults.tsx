import { useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NativeSelect } from '@/components/ui/native-select';
import { FieldHint } from '@/components/ui/field';
import { useChoiceText } from '@/features/forms/choice-text';
import { cn } from '@/lib/utils';
import { RADIO } from './AgentSettingsExecutable';
import { firstEnabledAgent, withFirstAgent } from './agent-settings-order';
import { taskDefaultRows, withTaskDefault, type AgentsDraft } from './agent-settings-draft';

/**
 * Where owners and members start when the request names nothing: the agent (the one marked, the first enabled one in
 * config order) and, for each enabled agent, the value of each row its launch uses. Part of the same draft as the
 * cards, so it is saved, and said unsaved, with them.
 */
export function TaskDefaults({ draft, onChange }: { draft: AgentsDraft; onChange: (draft: AgentsDraft) => void }) {
  const { t } = useTranslation('panels');
  const text = useChoiceText();
  const id = useId();
  // The rows keep the order they were first drawn in: marking an agent moves it to the top of config.yaml, not here,
  // so the row stays under the pointer.
  const seen = useRef<string[]>([]);
  for (const agent of draft.agents) if (!seen.current.includes(agent.id)) seen.current.push(agent.id);
  const enabled = draft.agents.filter(agent => agent.enabled !== false)
    .sort((a, b) => seen.current.indexOf(a.id) - seen.current.indexOf(b.id));
  const first = firstEnabledAgent(draft.agents);
  const change = (agentId: string, key: string, value: string) =>
    onChange({ ...draft, agents: draft.agents.map(agent => agent.id === agentId ? withTaskDefault(agent, key, value) : agent) });
  if (!enabled.length) return null;
  return <div className="flex flex-col gap-2">
    <section aria-labelledby={`${id}-title`} data-task-defaults className="min-w-0 rounded-lg border border-line bg-raised">
      <div className="px-4 pt-4 pb-3 narrow:px-3">
        <h3 id={`${id}-title`} className="text-base font-semibold">{t('agentSettings.taskDefaults.title')}</h3>
        <p className="mt-1 text-sm text-muted">{t('agentSettings.taskDefaults.lead')}</p>
      </div>
      <div role="radiogroup" aria-labelledby={`${id}-title`}>
        {enabled.map(agent => {
          const rows = taskDefaultRows(agent), chosen = first === agent.id, radio = `${id}-${agent.id}`;
          return <div key={agent.id} data-task-default={agent.name} className="border-t border-line px-4 py-3 narrow:px-3">
            <div className="flex items-start gap-x-6 gap-y-2 narrow:flex-col">
              <label htmlFor={radio} className="flex min-h-control-md w-40 shrink-0 cursor-pointer items-center gap-2 narrow:min-h-0 narrow:w-auto">
                <input id={radio} type="radio" name={`${id}-agent`} className={RADIO} checked={chosen}
                  onChange={() => onChange({ ...draft, agents: withFirstAgent(draft.agents, agent.id) })} />
                <span className={cn('font-semibold [overflow-wrap:anywhere]', !chosen && 'font-normal')}>{agent.name}</span>
                {chosen && <span className="rounded-full border border-line px-2 text-sm text-muted">{t('agentSettings.taskDefaults.badge')}</span>}
              </label>
              {/* Two rows to a line, each a name and its values, lined up in columns; one to a line on a phone. */}
              <div className="grid min-w-0 flex-1 grid-cols-[max-content_minmax(0,12rem)_max-content_minmax(0,12rem)] items-center gap-x-3 gap-y-2 narrow:w-full narrow:grid-cols-[5rem_minmax(0,1fr)]">
              {rows.map((row, at) => <label key={row.key} className="contents">
                <span className={cn('text-sm text-muted', at % 2 === 1 && 'ml-3 narrow:ml-0')}>{text.row(row.key)}</span>
                <NativeSelect variant="field" className="w-full font-mono" value={row.value}
                  aria-label={t('agentSettings.taskDefaults.valueFor', { agent: agent.name, row: text.row(row.key) })}
                  onChange={event => change(agent.id, row.key, event.target.value)}>
                  {row.values.map(value => <option key={value} value={value}>{value === '-' ? text(null) : value}</option>)}
                </NativeSelect>
              </label>)}
              </div>
            </div>
            {rows.filter(row => row.missing).map(row => <FieldHint key={row.key} className="mt-2 text-warn">
              {t('agentSettings.taskDefaults.missing', { row: text.row(row.key), value: agent.defaults![row.key], first: row.value === '-' ? text(null) : row.value })}</FieldHint>)}
          </div>;
        })}
      </div>
      <p className="border-t border-line px-4 py-3 text-sm text-muted narrow:px-3">{t('agentSettings.taskDefaults.agentNote')}</p>
    </section>
    <p className="text-sm text-muted">{t('agentSettings.taskDefaults.coordinatorNote')}</p>
  </div>;
}
