import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { AGENT_ADAPTERS, type BuiltinAdapterId } from '@alpacawork/contract/agent-adapters';
import { FieldError, FieldHint } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { SettingRow } from '@/components/settings/SettingRow';
import { useAgentExecutable } from '@/data/queries';
import { cn } from '@/lib/utils';
import { draftAdapter, type AgentDraft, type AgentDraftIssue } from './agent-settings-draft';
import { agentDraftIssueText } from './agent-settings-issues';
import { addAgentGuide, agentNotice, agentObservation, executableChoices, inspectablePath, withCommand, type AgentObservations } from './agent-status';

/** What the server last saw of each agent; undefined until it arrives, after the form. */
const ObservationsContext = createContext<AgentObservations | undefined>(undefined);
export const AgentObservationsProvider = ({ value, children }: { value: AgentObservations | undefined; children: ReactNode }) =>
  <ObservationsContext value={value}>{children}</ObservationsContext>;
export const useAgentObservations = () => useContext(ObservationsContext);

/** A path or a command: long ones wrap anywhere rather than run out of the card or get cut. */
const Path = ({ children }: { children: ReactNode }) => <code className="font-mono [overflow-wrap:anywhere]">{children}</code>;

/** Drawn in ink like the switch beside it: an outline when off, a ring with a dot when chosen. */
export const RADIO = 'size-4 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-soft checked:border-ink checked:bg-[radial-gradient(circle,var(--color-ink)_0_3.5px,transparent_4px)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink';

/** The line a closed card shows under its name when the agent is known not to start; nothing otherwise. */
export function AgentNoticeLine({ agent }: { agent: AgentDraft }) {
  const { t } = useTranslation('panels');
  const notice = agentNotice(draftAdapter(agent), agentObservation(agent, useAgentObservations()));
  if (!notice) return null;
  return <p data-agent-notice className="basis-full text-sm text-muted">{notice.kind === 'signedOut'
    ? <>{t('agentSettings.signedOut')} <code className="whitespace-nowrap font-mono">{notice.action}</code></>
    : <>{t('agentSettings.notFound')} <Path>{notice.executable}</Path></>}</p>;
}

/** Under a kind chosen to add: where this PC has it, and how to sign in, as far as the server has seen (agent-status). */
export function AddAgentGuideLines({ adapter, environmentFile }: { adapter: BuiltinAdapterId; environmentFile: string | undefined }) {
  const { t } = useTranslation('panels');
  const detected = useAgentObservations()?.detected?.[adapter];
  const { place, signIn } = addAgentGuide(adapter, detected);
  const env = AGENT_ADAPTERS[adapter].defaultEnv[0];
  const action = AGENT_ADAPTERS[adapter].auth?.nextAction;
  return <>
    {place && <p className="mt-2 text-sm text-muted">{place === 'missing'
      ? <>{t('agentSettings.notFound')} <Path>{AGENT_ADAPTERS[adapter].command}</Path></>
      : <>{t('agentSettings.found')} <Path>{place.path}</Path>{place.version && <span className="ml-2">{place.version}</span>}</>}</p>}
    {signIn === 'signedOut' && <p className="mt-2 text-sm text-muted">{t('agentSettings.signedOut')} <code className="whitespace-nowrap font-mono">{detected!.nextAction}</code></p>}
    {/* The other way in is a key in the server's environment file, named once its place has been read. A kind with a
      sign-in check names its own next step; the others keep the general words. */}
    {signIn === 'general' && <p className="mt-2 text-sm text-muted">{action
      ? <Trans t={t} i18nKey={env && environmentFile ? 'agentSettings.authNeededCommandEnv' : 'agentSettings.authNeededCommand'}
        values={{ command: action, env, path: environmentFile }} components={{ code: <code className="whitespace-nowrap font-mono" /> }} />
      : env && environmentFile ? t('agentSettings.authNeededEnv', { adapter, env, path: environmentFile }) : t('agentSettings.authNeeded', { adapter })}</p>}
  </>;
}

/** The executable an agent runs: automatic (the server PATH's first), another same-named command on it, or a typed path. */
export function AgentExecutableRow({ agent, onChange, issues }: { agent: AgentDraft; onChange: (agent: AgentDraft) => void; issues: AgentDraftIssue[] }) {
  const { t } = useTranslation('panels');
  const id = useId();
  const adapter = draftAdapter(agent);
  const observations = useAgentObservations();
  const detected = adapter ? observations?.detected?.[adapter] : undefined;
  const choices = executableChoices(agent.command, detected);
  // Until the person picks, both follow `command` (the candidates arrive after the form). "Another place" then stays
  // chosen while its box is empty, which leaves no `command` to say so.
  const [typing, setTyping] = useState(false);
  const [typedText, setTyped] = useState<string | null>(null);
  const typed = typedText ?? (choices.selected === 'other' ? agent.command ?? '' : '');
  const selected = typing ? 'other' : choices.selected;
  const errors = issues.filter(issue => issue.field === 'command').map(issue => agentDraftIssueText(issue, t, agent)).join('\n');
  if (!adapter || AGENT_ADAPTERS[adapter].command === null) return null;
  const choose = (choice: string) => {
    setTyping(choice === 'other');
    onChange(withCommand(agent, choice === 'automatic' ? undefined : choice === 'other' ? typed || undefined : choice));
  };
  const name = `${id}-executable`;
  return <SettingRow id={`${id}-other`} label={t('agentSettings.executable')} className="grid-cols-[10rem_minmax(0,1fr)] items-start narrow:grid-cols-1 narrow:gap-y-2">
    <div role="radiogroup" aria-labelledby={`${id}-other-label`} className="min-w-0 space-y-2">
      <label className="flex items-start gap-2">
        <input type="radio" name={name} className={cn(RADIO, 'mt-1')} checked={selected === 'automatic'} onChange={() => choose('automatic')} />
        <span className="shrink-0">{t('agentSettings.automatic')}</span>
        {choices.automatic && <Candidate path={choices.automatic.path} version={choices.automatic.version} />}
        {detected && !choices.automatic && <span className="text-sm text-muted">{t('agentSettings.notFoundShort')}</span>}
      </label>
      {choices.others.map(candidate => <label key={candidate.path} className="flex items-start gap-2">
        <input type="radio" name={name} className={cn(RADIO, 'mt-1')} checked={selected === candidate.path} onChange={() => choose(candidate.path)} />
        <Candidate path={candidate.path} version={candidate.version} />
      </label>)}
      <div className="flex items-start gap-2 narrow:flex-wrap">
        <label className="flex min-h-control-md shrink-0 items-center gap-2">
          <input type="radio" name={name} className={RADIO} checked={selected === 'other'} onChange={() => choose('other')} />
          <span>{t('agentSettings.otherPlace')}</span>
        </label>
        {/* Grows with the path, so a long one wraps and stays readable whole instead of scrolling inside the box. */}
        <Textarea id={`${id}-other`} rows={1} className="min-h-control-md min-w-0 flex-1 resize-none font-mono [field-sizing:content] [overflow-wrap:anywhere] narrow:basis-full"
          value={typed} placeholder={`/path/to/${AGENT_ADAPTERS[adapter].command}`}
          spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-invalid={!!errors} aria-describedby={`${id}-typed`}
          onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}
          onChange={event => { const text = event.target.value.replace(/[\r\n]/g, ''); setTyped(text); setTyping(true); onChange(withCommand(agent, text || undefined)); }} />
      </div>
      <div id={`${id}-typed`}>
        {errors ? <FieldError>{errors}</FieldError> : selected === 'other' && <TypedPathVersion adapter={adapter} path={typed} />}
      </div>
    </div>
  </SettingRow>;
}

/** A path and its version. On a narrow screen the version wraps to its own line, starting where the path starts. */
const Candidate = ({ path, version }: { path: string; version: string | null }) => <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
  <Path>{path}</Path>{version && <span className="text-sm text-muted">{version}</span>}
</span>;

/** The typed path's version, asked for once typing pauses; or that it cannot be run. */
function TypedPathVersion({ adapter, path }: { adapter: BuiltinAdapterId; path: string }) {
  const { t } = useTranslation('panels');
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!inspectablePath(path)) { setSettled(null); return; }
    const timer = setTimeout(() => setSettled(path), 400);
    return () => clearTimeout(timer);
  }, [path]);
  const asked = settled === path ? settled : null;
  const result = useAgentExecutable(adapter, asked);
  if (!asked || !result.data) return null;
  if (result.data.issue) return <FieldError>{t('agentSettings.cannotRun')}</FieldError>;
  return <FieldHint>{result.data.version ?? t('agentSettings.noVersion')}</FieldHint>;
}
