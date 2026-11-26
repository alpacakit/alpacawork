import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Controller, FormProvider, useFormContext, useFormState, useWatch, type FieldPath } from "react-hook-form";
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
import { followRenames } from './ai-stack-draft';
import { AgentObservationsProvider } from './AgentSettingsExecutable';
import { EnvironmentFileLine, EnvironmentFileProblems, useEnvironmentFile } from './EnvironmentFile';
import { validateAgentsDraft } from './agent-settings-draft';
import { agentDraftIssueText } from './agent-settings-issues';
import { STACK_FIELDS, serverAgentDraftSchema, serverAgentsYaml, stackKind, type StackField } from './server-agent-draft';
import { apiError } from "@/data/client";
import type { WriteBasis } from "@/data/connection";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useAgentStatus, useSaveServerSettings, useServerSettings, useWorkspaceInfo, useWriteDisabled } from "@/data/queries";
import { intentKey, useWriteIntent } from "@/data/write-intent";
import { useAnswerGuard } from "@/features/forms/answer-guard";
import { FormError, SubmitButton, useServerForm, type ServerForm } from "@/features/forms/server-form";
import { SaveUnconfirmed } from "./SaveUnconfirmed";
import { serverDraftActions, type ServerDraftActions } from "./server-draft-actions";
import { WorkspaceFolderLine } from "./WorkspaceFolderLine";
import { YamlTab } from "./YamlTab";
import { configYaml, serverDraft, type ServerDraft } from "./settings-draft";

/** The settings tabs that show a part of the config.yaml draft: AI its stacks and agents, General its limits. */
export type ServerDraftTab = "ai" | "general";

type ConfigPayload = { yaml: string; agents: string; expected: string };

/** Where a part of the draft stands: the AI tab, or General's Advanced options. */
type DraftPlace = "ai" | "advanced";
/**
 * Each part of config.yaml the draft edits, by the name serve gives it (serverSettingsSchema): the draft field it is
 * drawn in and where that stands. A refused field is shown there, and an unsaved change is named by it.
 */
const DRAFT_PARTS = {
  limits: { field: "limits", place: "advanced" },
  agents: { field: "agents", place: "ai" },
  agentsText: { field: "agents", place: "ai" },
  aiStack: { field: "aiStack", place: "ai" },
  coordinatorAiStack: { field: "coordinatorAiStack", place: "ai" },
} as const satisfies Record<string, { field: keyof ServerDraft; place: DraftPlace }>;
const PLACE_ORDER: readonly DraftPlace[] = ["ai", "advanced"];
const partOf = (name: string) => Object.hasOwn(DRAFT_PARTS, name) ? DRAFT_PARTS[name as keyof typeof DRAFT_PARTS] : undefined;
/**
 * The draft field a path serve names stands for: a limit by its name, a stack's row by its number, the agents as a
 * whole (their cards say which value). None: said in the save row.
 */
function draftFieldOf(path: string): FieldPath<ServerDraft> | undefined {
  const [head = "", next] = path.split(".");
  const part = partOf(head);
  if (!part) return undefined;
  if (part.field === "limits") return next && (LIMIT_KEYS as readonly string[]).includes(next) ? `limits.${next}` as FieldPath<ServerDraft> : "limits";
  if (part.field === "agents") return "agents";
  return next !== undefined && /^\d+$/.test(next) ? `${part.field}.${Number(next)}` as FieldPath<ServerDraft> : part.field;
}

/** After the tab just shown has drawn. */
const afterPaint = (then: () => void) => requestAnimationFrame(() => requestAnimationFrame(then));

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

type ServerDraftContextValue = {
  form: ServerForm<ServerDraft>;
  /** What stands in the draft's place while config.yaml is read, or when it can't be: null once the draft is ready. */
  unready: ReactNode;
  /** The draft is still being read (no failure): the places it fills show their placeholders. */
  loading: boolean;
  /** What can be pressed or typed now (serverDraftActions), read by every field and button of both places. */
  actions: ServerDraftActions;
  reload: () => Promise<void>;
  unconfirmed: boolean;
  unproven: boolean;
  save: () => void;
  /** Shows a refused stack's row to fix, in the AI tab. */
  showStack: (field: StackField) => void;
  advancedOpen: boolean;
  setAdvancedOpen: (open: boolean) => void;
  environmentFile: ReturnType<typeof useEnvironmentFile>["data"];
};
const ServerDraftContext = createContext<ServerDraftContextValue | null>(null);
const useServerDraft = () => {
  const state = useContext(ServerDraftContext);
  if (!state) throw new Error("useServerDraft outside ServerDraftProvider");
  return state;
};

/**
 * This PC's config.yaml as one draft for the whole settings dialog: what it was last read or saved as (with its hash),
 * saved when changed, all of it at once. The AI and General tabs each show a part of it with the same save row, so a
 * change made in one is saved from either. A save refused for a field takes the eye to it, in whichever tab it stands.
 * `focusCoordinatorAi`: asked again each time it changes (the dialog's request count): the input's AI stack is brought
 * into view with its heading focused, once the settings are read.
 */
export function ServerDraftProvider({ show, focusCoordinatorAi, children }: {
  show: (tab: ServerDraftTab) => void; focusCoordinatorAi?: number; children: ReactNode;
}) {
  const { t } = useTranslation("panels");
  const server = useServerSettings(true);
  const environmentFile = useEnvironmentFile().data;
  const [base, setBase] = useState<{ hash: string; draft: ServerDraft } | null>(null);
  const root = useWorkspaceInfo(info => info.root);
  const writeDisabled = useWriteDisabled();
  /** Advanced options start folded; a save their limits refuse opens them. */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const saveSettings = useSaveServerSettings({ errorToast: false });
  const intent = useWriteIntent<ConfigPayload, ServerSettings>(intentKey(root, "server-settings", null), input => ({ path: 'config/set', response: 'settings', body: { expectedConfigHash: input.expected, config: input.yaml, agents: input.agents } }));
  const send = (input: ConfigPayload, opId: string, basis?: WriteBasis) => saveSettings.mutateAsync({ ...input, opId, basis });
  const busy = intent.status === "pending" || intent.status === "unconfirmed";
  const form = useServerForm<ServerDraft>({ schema: serverAgentDraftSchema, issueField: draftFieldOf,
    submit: async valid => {
      if (base === null || writeDisabled || busy) return false;
      const answer = capture();
      const agents = serverAgentsYaml(valid);
      if (!agents.ok) {
        form.setError('agents', { type: 'validate', message: t('agentSettings.errors.invalidValue') });
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
  });
  const capture = useAnswerGuard(form);
  const [reloading, setReloading] = useState(false);
  const { isSubmitting, isDirty } = useFormState({ control: form.control });
  const loaded = server.data && !server.data.error && server.data.hash ? server.data : undefined;
  // The draft starts from a read of config.yaml made for this opening, not a cached one; later reads do not move it.
  useEffect(() => {
    if (!loaded || base !== null || !server.isFetchedAfterMount) return;
    const draft = serverDraft(loaded);
    form.reset(draft);
    setBase({ hash: loaded.hash!, draft });
  }, [loaded, base, form, server.isFetchedAfterMount]);

  const ready = base !== null;
  const actions = serverDraftActions({ dirty: isDirty, writable: !writeDisabled, saving: intent.status === "pending",
    unconfirmed: intent.status === "unconfirmed", otherWrite: intent.blocked,
    awaited: intent.status === "pending" || isSubmitting || reloading });
  useEffect(() => {
    if (focusCoordinatorAi === undefined || !ready) return;
    afterPaint(() => {
      const heading = document.getElementById(stackHeadingId('coordinator'));
      heading?.closest('section')?.scrollIntoView?.({ block: 'start' });
      heading?.focus({ preventScroll: true });
    });
  }, [focusCoordinatorAi, ready]);

  const showStack = (field: StackField) => { show("ai"); afterPaint(() => focusStackIssue(field)); };
  /**
   * The one way a refused save is shown, from either save row and for the screen's own check or serve's: the agents and
   * the stacks in the AI tab come first, as they stand first there; then the limits, in General's Advanced options.
   */
  const showRefusal = () => {
    const refused = (name: Parameters<typeof form.getFieldState>[0]) => form.getFieldState(name).invalid;
    const stack = STACK_FIELDS.find(refused);
    if (refused('agents')) {
      show("ai");
      // A card the screen finds wrong takes the focus; a refusal only serve gave stands under the cards.
      afterPaint(() => {
        form.setFocus('agents');
        if (document.getElementById('server-agents')?.contains(document.activeElement)) return;
        const said = document.querySelector<HTMLElement>('[data-agents-refused]');
        said?.scrollIntoView?.({ block: 'center' });
        said?.focus({ preventScroll: true });
      });
    }
    else if (stack) showStack(stack);
    else if (refused('limits')) {
      const limit = LIMIT_KEYS.find(name => refused(`limits.${name}`));
      setAdvancedOpen(true);
      show("general");
      // Brought into view first: the tab just shown starts at its top.
      if (limit) afterPaint(() => {
        const field = document.getElementById(`limit-${limit}`);
        field?.scrollIntoView?.({ block: 'center' });
        field?.focus({ preventScroll: true });
      });
    }
  };
  const save = () => void form.save().then(saved => { if (!saved) showRefusal(); });

  // Marked while it runs, so neither place reads again or saves meanwhile.
  const reload = async () => {
    setReloading(true);
    try {
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
    } finally { setReloading(false); }
  };
  const unready = server.data?.error ? <ReadFailure what={t("settings.server.readError")} error={apiError(server.data.error)} retry={() => void reload()} disabled={!actions.reread} />
    : server.isError ? <ReadFailure what={t("settings.personal.loadError")} error={server.error} retry={() => void reload()} disabled={!actions.reread} />
    : null;
  // Still reading: each place the draft fills draws its own shape meanwhile (`unready` is only a read that failed).
  const loading = !unready && (!loaded || base === null);

  return <ServerDraftContext.Provider value={{ form, unready, loading, actions, reload,
    unconfirmed: intent.status === "unconfirmed", unproven: intent.unproven, save, showStack, advancedOpen, setAdvancedOpen,
    environmentFile }}>
    <FormProvider {...form}>{children}</FormProvider>
  </ServerDraftContext.Provider>;
}

/** The draft's save row, the same wherever it stands: what is unsaved, why a save was refused, discard and save. */
function ServerDraftFoot() {
  const { t } = useTranslation("panels");
  const { form, actions, reload, unconfirmed, unproven, save, showStack } = useServerDraft();
  const { isDirty, errors, dirtyFields } = useFormState({ control: form.control });
  // The draft is one, so either save row saves or discards it all: it names where its changes stand.
  const changed = PLACE_ORDER.filter(place => Object.keys(dirtyFields).some(name => partOf(name)?.place === place));
  const placeName = (place: DraftPlace) => place === "ai" ? t("settings.tabs.ai") : `${t("settings.tabs.general")} → ${t("settings.server.advanced")}`;
  const status = !isDirty ? t("settings.status.saved") : changed.length
    ? t("settings.status.dirtyIn", { places: changed.map(placeName).join(t("settings.status.placeSeparator")) }) : t("settings.status.dirty");
  // On a PC the save row, with why a save was refused and what to do next, is kept at the window's foot while the
  // fields above scroll, so whether a save is needed, and why one did not go through, are always in view; it reaches
  // down over the body's bottom room, and its own clears the body's fade. A field moved to comes into view above it
  // (keepFieldsClear). On a phone it all stays in the page's flow, last: kept in view it would cover the field being
  // typed in over the keyboard.
  return <div ref={keepFieldsClear} data-settings-foot-block
    className="sticky -bottom-3 z-10 mt-6 flex flex-col gap-3 border-t border-line bg-raised pt-4 pb-4 narrow:static narrow:contents">
    <FormError form={form} onReread={unproven ? undefined : reload} rereadLabel={t("settings.server.reload")} disabled={!actions.reread} />
    {unconfirmed && <SaveUnconfirmed unproven={unproven} onReread={() => void reload()} disabled={!actions.reread} />}
    <DialogFooter data-settings-foot className="mt-0 flex-wrap border-t-0 pt-0 narrow:mt-4.5 narrow:border-t narrow:pt-4">
      <div className="min-w-0 flex-1 basis-60 narrow:basis-full">
        <FieldHint role="status">{status}</FieldHint>
        {/* A save a stack refused says why beside the button, and takes the eye to the row to fix. */}
        {STACK_FIELDS.map(field => errors[field] && <FieldError key={field} data-ai-stack-refused={stackKind(field)} className="mt-type-close">
          {t('agentSettings.aiStack.saveRefused', { list: t(stackTitleKey(stackKind(field))) })}{' '}
          <Button type="button" variant="ref" onClick={() => showStack(field)}>{t('agentSettings.aiStack.showRow')}</Button></FieldError>)}
        {/* What a save leaves as it was, said only while there is something to save. */}
        {isDirty && <FieldHint data-settings-effect className="mt-type-close">{t("settings.server.effect")}</FieldHint>}
      </div>
      <Button variant="outline" disabled={!actions.discard} onClick={() => form.reset()}>
        {t("settings.discard")}
      </Button>
      <SubmitButton form={form} disabled={!actions.save} label={t("settings.server.save")} onClick={save} />
    </DialogFooter>
  </div>;
}

/**
 * One rule for the dialog body's foot room: as tall as the save row kept in view there now, and none when no such row
 * is shown (another tab, the options folded, a phone, where it is in the flow). It is asked again whenever a save row
 * appears, goes or changes height, or a fold in the body opens or closes (a folded row keeps its size), so the order
 * the tabs and folds were opened in does not matter. The field in hand is brought clear of a row that grew over it.
 */
function keepFieldsClear(block: HTMLDivElement | null) {
  const body = block?.closest<HTMLElement>('[data-slot="dialog-body"]');
  if (!block || !body) return;
  const fit = () => {
    const shown = [...body.querySelectorAll<HTMLElement>("[data-settings-foot-block]")]
      .find(each => (each.checkVisibility?.() ?? true) && each.offsetHeight > 0 && getComputedStyle(each).position === "sticky");
    body.style.scrollPaddingBottom = shown ? `${shown.offsetHeight}px` : "";
    // A row that grew (a first change adds its note, a refusal its reason) must not cover the field in hand.
    const held = document.activeElement;
    if (!shown || !(held instanceof HTMLElement) || !body.contains(held) || shown.contains(held)) return;
    const field = held.getBoundingClientRect(), row = shown.getBoundingClientRect();
    if (field.bottom > row.top && field.top < row.bottom) held.scrollIntoView({ block: "nearest" });
  };
  const observer = new ResizeObserver(fit);
  observer.observe(block);
  body.addEventListener("toggle", fit, true);
  return () => { observer.disconnect(); body.removeEventListener("toggle", fit, true); fit(); };
}

/**
 * The AI tab: the draft's AI stacks (tasks', then the input's) and the agents their rows pick from, for every project
 * alike, then the save row. When config.yaml can't be read, the folder it is read from stands under the failure.
 */
export function AiSettingsTab() {
  const { t } = useTranslation("panels");
  const { unready, loading, actions, environmentFile } = useServerDraft();
  const scope = <FieldHint className="mb-6">{t("settings.scope.server")}</FieldHint>;
  if (loading) return <>{scope}<RegionSkeleton shape="settingsAi" /></>;
  if (unready) return <>{scope}{unready}<WorkspaceFolderLine /></>;
  return <>
    {scope}
    <EnvironmentFileProblems file={environmentFile} />
    <AiFields disabled={!actions.edit} environmentFile={environmentFile?.path} />
    <ServerDraftFoot />
  </>;
}

function AiFields({ disabled, environmentFile }: { disabled: boolean; environmentFile: string | undefined }) {
  const { t } = useTranslation("panels");
  const { control, getValues, setValue } = useFormContext<ServerDraft>();
  const draft = useWatch({ control }) as ServerDraft;
  const { errors } = useFormState({ control });
  // Read beside the form, not before it: it waits on each agent's own checks.
  const status = useAgentStatus().data;
  const reportedContext = useServerSettings().data?.reportedContext;
  const agentIssues = draft.agents.ok ? validateAgentsDraft(draft.agents.value) : draft.agents.issues;
  // What serve refused in a stack (draftFieldOf): by row when it named one, else the stack as a whole.
  const refusal = (name: StackField) => errors[name] as { message?: string; type?: string } | (({ message?: string } | undefined)[]) | undefined;
  const refusedRows = (name: StackField) => { const refused = refusal(name); return Array.isArray(refused) ? refused.map(row => row?.message) : undefined; };
  const refusedStack = (name: StackField) => { const refused = refusal(name); return refused && !Array.isArray(refused) && refused.type === 'server' ? refused.message : undefined; };
  return <div id="server-agents">
    {/* Initial release: keep the Decision API fields for later (with SettingSection, register and DEFAULT_JEV_SETTINGS).
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
    {/* The stacks the agents run in (tasks', then the input's), above the agents whose choices their rows pick from. */}
    {draft.agents.ok && STACK_FIELDS.map(name => <fieldset key={name} disabled={disabled} className="mb-4 min-w-0 border-0 p-0"><Controller name={name} control={control} render={({ field }) =>
      <AiStack kind={stackKind(name)} rows={field.value} agents={draft.agents.ok ? draft.agents.value.agents : []} onChange={field.onChange}
        refusedRows={refusedRows(name)} refused={refusedStack(name)} />} /></fieldset>)}
    {/* Under the stacks, the agents get their own heading, so their cards do not read as more rows of them. */}
    {draft.agents.ok && <div className="mb-3">
      <h3 className="text-base font-semibold">{t('agentSettings.aiStack.agentsTitle')}</h3>
      <p className="mt-1 text-sm text-muted">{t('agentSettings.aiStack.agentsNote')}</p>
    </div>}
    <Controller name="agents" control={control} render={({ field }) => field.value.ok
      ? <AgentObservationsProvider value={status && !status.error ? status : undefined}>
        <AgentSettings ref={field.ref} draft={field.value.value} issues={agentIssues} disabled={disabled} environmentFile={environmentFile} reportedContext={reportedContext}
          onChange={value => {
            // A row of either stack follows its agent's new name.
            const before = field.value;
            for (const stack of STACK_FIELDS) {
              const rows = getValues(stack), followed = before.ok ? followRenames(rows, before.value, value) : rows;
              if (followed !== rows) setValue(stack, followed, { shouldDirty: true });
            }
            field.onChange({ ok: true, value });
          }} /></AgentObservationsProvider>
      : <FieldError ref={field.ref} tabIndex={-1}>{agentIssues.map(issue => agentDraftIssueText(issue, t)).join('\n')}</FieldError>} />
    {errors.agents && agentIssues.length === 0 && <FieldError data-agents-refused tabIndex={-1}>
      {errors.agents.type === 'server' && errors.agents.message ? errors.agents.message : t('agentSettings.errors.invalidValue')}</FieldError>}
  </div>;
}

/**
 * General's Advanced options, folded and for whoever runs the server: the draft's run limits, the YAML a save writes,
 * and the save row, which saves the whole draft (an unsaved change made in the AI tab too).
 */
export function AdvancedServerOptions() {
  const { t } = useTranslation("panels");
  const { unready, loading, advancedOpen, setAdvancedOpen } = useServerDraft();
  return <details id="server-advanced" className="border-t border-line" open={advancedOpen}
    onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
    {/* Closed, the fold is a row of the tab's list: the same line over it and the same height. */}
    <DisclosureSummary className={cn(SETTING_ROW_SIZE, "flex-wrap content-center gap-x-2 text-base font-semibold")}>
      <Caret open={advancedOpen} />{t("settings.server.advanced")}</DisclosureSummary>
    <FieldHint>{t("settings.server.advancedNote")}</FieldHint>
    <div className="mt-2 pb-6">{loading ? <RegionSkeleton shape="settingRows" rows={3} /> : unready ?? <>
      <LimitFields />
      <ServerYamlExample />
      <ServerDraftFoot />
    </>}</div>
  </details>;
}

function LimitFields() {
  const { t } = useTranslation("panels");
  const { register } = useFormContext<ServerDraft>();
  const { errors } = useFormState<ServerDraft>();
  const { actions } = useServerDraft();
  // A fieldset holds the fields still without dropping their values from the draft, as the AI tab's do.
  return <SettingSection id="server-limits" title={t("settings.server.limits")} sub><fieldset disabled={!actions.edit} className="m-0 flex min-w-0 flex-col border-0 p-0">
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
  </fieldset></SettingSection>;
}

function ServerYamlExample() {
  const { t } = useTranslation('panels');
  const draft = useWatch<ServerDraft>() as ServerDraft;
  const [open, setOpen] = useState(false);
  const agents = open ? serverAgentsYaml(draft) : undefined;
  return <details className="mt-6 text-base" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <DisclosureSummary className="gap-x-2 text-sm text-muted hover:text-ink"><Caret open={open} />{t('settings.server.yamlExample')}</DisclosureSummary>
    {agents && (agents.ok ? <YamlTab yaml={`${configYaml(draft)}${agents.value}`} /> : <FieldError>{t('agentSettings.errors.invalidValue')}</FieldError>)}
  </details>;
}

/** The folder this server reads and its environment file, at the foot of General: looked up, not set. */
export function ServerFolderLines() {
  const environmentFile = useEnvironmentFile().data;
  return <><WorkspaceFolderLine /><EnvironmentFileLine file={environmentFile} /></>;
}
