import { TelemetrySection } from "@/features/telemetry/Telemetry";
import { useEffect, useState, type ReactNode } from "react";
import { Controller, FormProvider, useFormContext, useFormState, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { /* DEFAULT_JEV_SETTINGS, */ DEFAULT_LIMITS, LIMIT_KEYS, LIMIT_MAXIMUM, LIMIT_MINIMUM, type ServerSettings } from "@alpacawork/contract";
import { SettingSection } from "@/components/settings/SettingSection";
import { SETTING_ROW_SIZE, SettingRow } from "@/components/settings/SettingRow";
import { Button } from "@/components/ui/button";
import { Caret, DisclosureSummary } from "@/components/ui/caret";
import { DialogFooter } from "@/components/ui/dialog";
import { FieldError, FieldHint } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ReadFailure } from "@/components/ui/loadable";
import { cn } from "@/lib/utils";
import { AgentSettings } from './AgentSettings';
import { AiStack, stackHeadingId, stackTitleKey } from './AiStack';
import { followAgents } from './ai-stack-draft';
import { AgentObservationsProvider } from './AgentSettingsExecutable';
import { EnvironmentFileLine, EnvironmentFileProblems, useEnvironmentFile } from './EnvironmentFile';
import { validateAgentsDraft } from './agent-settings-draft';
import { agentDraftIssueText } from './agent-settings-issues';
import { STACK_FIELDS, serverAgentDraftSchema, serverAgentsYaml, stackKind, type StackField } from './server-agent-draft';
import { apiError } from "@/data/client";
import type { WriteBasis } from "@/data/connection";
import { useAgentStatus, useSaveServerSettings, useServerSettings, useWorkspaceInfo, useWriteDisabled } from "@/data/queries";
import { intentKey, useWriteIntent } from "@/data/write-intent";
import { useAnswerGuard } from "@/features/forms/answer-guard";
import { FormError, SubmitButton, useServerForm } from "@/features/forms/server-form";
import { SaveUnconfirmed } from "./SaveUnconfirmed";
import { WorkspaceFolderLine } from "./WorkspaceFolderLine";
import { YamlTab } from "./YamlTab";
import { configYaml, serverDraft, type ServerDraft } from "./settings-draft";


type ConfigPayload = { yaml: string; agents: string; expected: string };
/** The first row of a stack that keeps a save back: brought into view, its control to fix focused. */
function focusStackIssue(field: StackField) {
  const stack = document.querySelector<HTMLElement>(`[data-ai-stack="${stackKind(field)}"]`);
  const target = stack?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? stack?.querySelector<HTMLElement>('[data-ai-stack-row][data-invalid] select')
    ?? stack?.querySelector<HTMLElement>('[data-slot="field-error"]');
  if (!target) return;
  target.scrollIntoView?.({ block: 'center' });
  if (!target.matches('select, input, button')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/** This PC's config.yaml as a draft: what it was last read or saved as (with its hash), saved when changed. */
/**
 * `focusCoordinatorAi`: asked again each time it changes (the dialog's request count): the agents unfold and the input's
 * AI stack is brought into view with its heading focused, once the settings are read.
 */
export function ServerSettingsTab({ focusCoordinatorAi }: { focusCoordinatorAi?: number } = {}) {
  const { t } = useTranslation("panels");
  const server = useServerSettings(true);
  const environmentFile = useEnvironmentFile().data;
  const [base, setBase] = useState<{ hash: string; draft: ServerDraft } | null>(null);
  const root = useWorkspaceInfo(info => info.root);
  const writeDisabled = useWriteDisabled();
  /** Both folds start closed; a refused save opens the one the problem is inside. */
  const [folds, setFolds] = useState({ agents: false, advanced: false });
  const unfold = (name: keyof typeof folds) => setFolds(was => ({ ...was, [name]: true }));
  const save = useSaveServerSettings({ errorToast: false });
  const intent = useWriteIntent<ConfigPayload, ServerSettings>(intentKey(root, "server-settings", null), input => ({ path: 'config/set', response: 'settings', body: { expectedConfigHash: input.expected, config: input.yaml, agents: input.agents } }));
  const send = (input: ConfigPayload, opId: string, basis?: WriteBasis) => save.mutateAsync({ ...input, opId, basis });
  const busy = intent.status === "pending" || intent.status === "unconfirmed";
  const form = useServerForm<ServerDraft>({ schema: serverAgentDraftSchema,
    submit: async valid => {
      if (base === null || writeDisabled || busy) return false;
      const answer = capture();
      const agents = serverAgentsYaml(valid);
      if (!agents.ok) {
        form.setError('agents', { type: 'validate', message: t('agentSettings.errors.invalidValue') });
        unfold('agents');
        return false;
      }
      const config = { yaml: configYaml(valid), agents: agents.value, expected: base.hash };
      const saving = intent.submit(() => config, send);
      if (saving === undefined) return false;
      const saved = await saving;
      if (!answer.sameDraft()) return;
      const draft = serverDraft(saved);
      setBase({ hash: saved.hash ?? base.hash, draft });
      form.reset(draft);
    },
    onInvalid: errors => {
      const refused = STACK_FIELDS.find(field => errors[field]);
      if (errors.agents || refused) unfold('agents');
      if (errors.limits) unfold('advanced');
      // A refused stack takes the eye to the row to fix, once its fold has opened.
      if (refused && !errors.agents) requestAnimationFrame(() => requestAnimationFrame(() => focusStackIssue(refused)));
    },
  });
  const capture = useAnswerGuard(form);
  const { isDirty, errors: formErrors } = useFormState({ control: form.control });
  const loaded = server.data && !server.data.error && server.data.hash ? server.data : undefined;
  // The draft starts from a read of config.yaml made for this opening, not a cached one; later reads do not move it.
  useEffect(() => {
    if (!loaded || base !== null || !server.isFetchedAfterMount) return;
    const draft = serverDraft(loaded);
    form.reset(draft);
    setBase({ hash: loaded.hash!, draft });
  }, [loaded, base, form, server.isFetchedAfterMount]);

  const ready = base !== null;
  useEffect(() => {
    if (focusCoordinatorAi === undefined || !ready) return;
    unfold('agents');
    // Once the fold has opened and drawn the stack.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const heading = document.getElementById(stackHeadingId('coordinator'));
      heading?.closest('section')?.scrollIntoView?.({ block: 'start' });
      heading?.focus({ preventScroll: true });
    }));
  }, [focusCoordinatorAi, ready]);

  const reload = async () => {
    const answer = capture();
    // A save whose answer was lost is sent again first, as the same operation: its answer is what was written.
    try {
      if (intent.status === "unconfirmed") await intent.retrySame(send);
    } catch (error) { if (form.retainCheckFailure(error)) return; }
    const latest = (await server.refetch()).data;
    if (!latest?.hash || latest.error || !answer.sameDraft()) return;
    intent.reset();
    form.clearFailure();
    const draft = serverDraft(latest);
    form.reset(draft);
    setBase({ hash: latest.hash, draft });
  };
  const unready = server.data?.error ? <ReadFailure what={t("settings.server.readError")} error={apiError(server.data.error)} retry={() => void reload()} />
    : server.isError ? <ReadFailure what={t("settings.personal.loadError")} error={server.error} retry={() => void reload()} />
    : !loaded || base === null ? <FieldHint role="status">{t("settings.personal.loading")}</FieldHint> : null;
  // While config.yaml loads, usage data waits for the list it closes, so the row does not jump down when the list
  // arrives; when config.yaml can't be read, it still stands under the failure so the choice can be changed.
  const failed = !!server.data?.error || server.isError;
  if (unready) return <><FieldHint className="mb-6">{t("settings.scope.server")}</FieldHint>{unready}
    {failed && <div className="mt-6 border-b border-line"><TelemetrySection /></div>}<WorkspaceFolderLine /></>;

  return (
    <FormProvider {...form}>
      <FieldHint className="mb-6">{t("settings.scope.server")}</FieldHint>
      <EnvironmentFileProblems file={environmentFile} />
      {/* Usage data closes the tab's list, after this PC's own settings, where settings lists usually keep it. */}
      <div className="border-b border-line">
        <ServerFields folds={folds} onFoldsChange={setFolds} disabled={writeDisabled || busy || intent.blocked} environmentFile={environmentFile?.path} />
        <TelemetrySection />
      </div>
      <WorkspaceFolderLine />
      <EnvironmentFileLine file={environmentFile} />
      <FormError form={form} onReread={intent.unproven ? undefined : reload} rereadLabel={t("settings.server.reload")} />
      {intent.status === "unconfirmed" && <SaveUnconfirmed unproven={intent.unproven} onReread={() => void reload()} />}
      {/* In the page's flow, last: on a phone a foot kept in view would cover the field being typed in over the keyboard. */}
      <DialogFooter data-settings-foot className="flex-wrap">
        <div className="min-w-0 flex-1 basis-60 narrow:basis-full">
          <FieldHint role="status">{isDirty ? t("settings.status.dirty") : t("settings.status.saved")}</FieldHint>
          {/* A save the stack refused says why beside the button, and takes the eye to the row to fix. */}
          {STACK_FIELDS.map(field => formErrors[field] && <FieldError key={field} data-ai-stack-refused={stackKind(field)} className="mt-type-close">
            {t('agentSettings.aiStack.saveRefused', { list: t(stackTitleKey(stackKind(field))) })}{' '}
            <Button type="button" variant="ref" onClick={() => focusStackIssue(field)}>{t('agentSettings.aiStack.showRow')}</Button></FieldError>)}
          <FieldHint className="mt-type-close">{t("settings.server.effect")}</FieldHint>
        </div>
        <Button variant="outline" disabled={!isDirty} onClick={() => form.reset()}>
          {t("settings.discard")}
        </Button>
        <SubmitButton form={form} disabled={!isDirty || writeDisabled || busy || intent.blocked}
          label={t("settings.server.save")} onClick={() => void form.save()} />
      </DialogFooter>
    </FormProvider>
  );
}

/**
 * This PC's part of config.yaml, for every project alike, in two folds: the agents first, naming the ones in use while
 * closed; then the limits, for whoever runs the server, under Advanced options.
 */
type Folds = { agents: boolean; advanced: boolean };
function ServerFields({ folds, onFoldsChange, disabled, environmentFile }: {
  folds: Folds; onFoldsChange: (folds: Folds) => void; disabled: boolean; environmentFile: string | undefined;
}) {
  const { t } = useTranslation("panels");
  const { control, register, getValues, setValue } = useFormContext<ServerDraft>();
  const draft = useWatch({ control }) as ServerDraft;
  const { errors } = useFormState({ control });
  // Read beside the form, not before it: it waits on each agent's own checks.
  const status = useAgentStatus().data;
  const agentIssues = draft.agents.ok ? validateAgentsDraft(draft.agents.value) : draft.agents.issues;
  const inUse = draft.agents.ok ? draft.agents.value.agents.filter(agent => agent.enabled !== false).map(agent => agent.name) : [];
  const fold = (name: keyof Folds) => ({ open: folds[name], onOpenChange: (open: boolean) => onFoldsChange({ ...folds, [name]: open }) });
  return <div>
    {/* Initial release: keep the Decision API fields for later.
    <SettingSection id="server-jev" title={t("settings.server.jev.title")} note={t("settings.server.jev.note")}>
      <SettingRow id="jev-endpoint" label={t("settings.server.jev.endpoint")} hint={t("settings.server.jev.endpointHint")}
        error={errors.jev?.endpoint ? t("settings.server.jev.problem.endpoint") : undefined}>
        <Input id="jev-endpoint" inputMode="url" spellCheck={false} aria-invalid={!!errors.jev?.endpoint}
          className="w-80 max-w-[50vw] min-w-0" {...register("jev.endpoint")} />
      </SettingRow>
      <SettingRow id="jev-model" label={t("settings.server.jev.model")} hint={t("settings.server.defaultHint", { value: DEFAULT_JEV_SETTINGS.model })}
        error={errors.jev?.model ? t("settings.server.jev.problem.model") : undefined}>
        <Input id="jev-model" spellCheck={false} aria-invalid={!!errors.jev?.model} className="w-48 max-w-[50vw] min-w-0" {...register("jev.model")} />
      </SettingRow>
      <SettingRow id="jev-key-env" label={t("settings.server.jev.keyEnv")} hint={t("settings.server.jev.keyEnvHint")}
        error={errors.jev?.api_key_env ? t("settings.server.jev.problem.keyEnv") : undefined}>
        <Input id="jev-key-env" spellCheck={false} aria-invalid={!!errors.jev?.api_key_env} className="w-48 max-w-[50vw] min-w-0 font-mono"
          {...register("jev.api_key_env")} />
      </SettingRow>
    </SettingSection>
    */}
    <ServerFold id="server-agents" title={t('agentSettings.title')} summary={inUse.length ? t('settings.server.agentsInUse', { names: inUse.join(', ') }) : undefined} {...fold('agents')}>
    {/* The stacks the agents run in (tasks', then the input's), above the agents whose choices their rows pick from. */}
    {draft.agents.ok && STACK_FIELDS.map(name => <fieldset key={name} disabled={disabled} className="mb-4 min-w-0 border-0 p-0"><Controller name={name} control={control} render={({ field }) =>
      <AiStack kind={stackKind(name)} rows={field.value} agents={draft.agents.ok ? draft.agents.value.agents : []} onChange={field.onChange} />} /></fieldset>)}
    {/* Under the stack, the agents get their own heading, so their cards do not read as more rows of it. */}
    {draft.agents.ok && <div className="mb-3">
      <h3 className="text-base font-semibold">{t('agentSettings.aiStack.agentsTitle')}</h3>
      <p className="mt-1 text-sm text-muted">{t('agentSettings.aiStack.agentsNote')}</p>
    </div>}
    <Controller name="agents" control={control} render={({ field }) => field.value.ok
      ? <AgentObservationsProvider value={status && !status.error ? status : undefined}>
        <AgentSettings ref={field.ref} draft={field.value.value} issues={agentIssues} disabled={disabled} environmentFile={environmentFile}
          onChange={value => {
            // The rows of either stack follow the agent edited here (followAgents).
            const before = field.value;
            for (const stack of STACK_FIELDS) {
              const rows = getValues(stack), followed = before.ok ? followAgents(rows, before.value, value) : rows;
              if (followed !== rows) setValue(stack, followed, { shouldDirty: true });
            }
            field.onChange({ ok: true, value });
          }} /></AgentObservationsProvider>
      : <FieldError ref={field.ref} tabIndex={-1}>{agentIssues.map(issue => agentDraftIssueText(issue, t)).join('\n')}</FieldError>} />
    {errors.agents && agentIssues.length === 0 && <FieldError>{t('agentSettings.errors.invalidValue')}</FieldError>}
    </ServerFold>
    <ServerFold id="server-advanced" title={t("settings.server.advanced")} note={t("settings.server.advancedNote")} {...fold('advanced')}>
        <SettingSection id="server-limits" title={t("settings.server.limits")} sub>
          {LIMIT_KEYS.map((limitName) => {
            const id = `limit-${limitName}`;
            const issue = errors.limits?.[limitName];
            const range = { min: LIMIT_MINIMUM[limitName], max: limitName === "attachment_mib" ? LIMIT_MAXIMUM[limitName] : null, value: DEFAULT_LIMITS[limitName] };
            return <SettingRow key={limitName} id={id} label={t(`settings.server.limit.${limitName}`)}
              hint={t(limitName === "coordinator_command_seconds" ? "settings.server.commandSecondsHint" : limitName === "run_minutes" ? "settings.server.runMinutesHint" : range.max === null ? "settings.server.defaultHint"
                : "settings.server.attachmentHint", range)}
              error={issue ? range.max === null ? t("settings.server.problem.minimum", { value: range.min })
                : t("settings.server.problem.range", range) : undefined}>
              <Input id={id} type="number" inputMode="numeric" aria-invalid={!!issue} className="w-20 text-right tabular-nums"
                {...register(`limits.${limitName}`, { valueAsNumber: true })} />
            </SettingRow>;
          })}
        </SettingSection>
        <ServerYamlExample draft={draft} />
    </ServerFold>
  </div>;
}

/** One folded part of the tab: a heading that opens it, with a line under it seen even while closed (summary), and a
 * note seen once open. */
function ServerFold({ id, title, summary, note, open, onOpenChange, children }: {
  id: string; title: string; summary?: string; note?: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode;
}) {
  return <details id={id} className="border-t border-line" open={open}
    onToggle={(event) => onOpenChange(event.currentTarget.open)}>
    {/* Closed, a fold is a row of the tab's list: the same line over it and the same height. */}
    <DisclosureSummary className={cn(SETTING_ROW_SIZE, "flex-wrap content-center gap-x-2 text-base font-semibold")}><Caret open={open} />{title}
      {summary && <span className="basis-full pl-4 text-sm font-normal text-muted">{summary}</span>}</DisclosureSummary>
    {note && <FieldHint>{note}</FieldHint>}
    <div className="mt-2 pb-6">{children}</div>
  </details>;
}

function ServerYamlExample({ draft }: { draft: ServerDraft }) {
  const { t } = useTranslation('panels');
  const [open, setOpen] = useState(false);
  const agents = open ? serverAgentsYaml(draft) : undefined;
  return <details className="mt-6 text-base" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <DisclosureSummary className="gap-x-2 text-sm text-muted hover:text-ink"><Caret open={open} />{t('settings.server.yamlExample')}</DisclosureSummary>
    {agents && (agents.ok ? <YamlTab yaml={`${configYaml(draft)}${agents.value}`} /> : <FieldError>{t('agentSettings.errors.invalidValue')}</FieldError>)}
  </details>;
}
