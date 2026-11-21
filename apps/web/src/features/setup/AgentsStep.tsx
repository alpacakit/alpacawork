import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { ReadFailure } from "@/components/ui/loadable";
import { Message } from "@/components/ui/message";
import { Switch } from "@/components/ui/switch";
import { textClip } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { recordFailure } from "@/lib/notify";
import { problemText } from "@/features/forms/problem-text";
import { useAgentStatus, useSaveServerSettings, useServerSettings, useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { useTelemetry } from "@/features/telemetry/data";
import { TelemetryDetailsLink } from "@/features/telemetry/TelemetryDetailsLink";
import { forgetLaunchAgent } from "@/features/forms/launch-choice";
import { readServerAgents, serverAgentsYaml } from "@/features/panels/server-agent-draft";
import { configYaml } from "@/features/panels/settings-draft";
import { agentDisplayName, canWork, chosenAgents, firstAgentOf, startAgents, usableAgents, type AgentSwitches, type StartAgent } from "./rules";
import { FailureLine, Loading, StepButtons } from "./parts";

type Failure = { at: "agents" | "consent" | "check"; detail: string } | null;

/**
 * Step 1: the agents this PC has, switched on or off, the one requests go to first, and the usage-data choice. Next
 * saves in that order (the agents only when changed), and a failure stays on the step where it failed.
 */
export function AgentsStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation("setup");
  const settings = useServerSettings(true);
  const status = useAgentStatus();
  const save = useSaveServerSettings({ errorToast: false });
  const telemetry = useTelemetry();
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  const loaded = settings.data && !settings.data.error && settings.data.hash ? settings.data : undefined;
  const drafts = useMemo(() => {
    const read = loaded ? readServerAgents(loaded.agentsText) : null;
    return read?.ok ? read.value : null;
  }, [loaded]);
  const rows = useMemo(() => drafts ? startAgents(drafts.agents, status.data, status.isFetching) : [], [drafts, status.data, status.isFetching]);
  // The switches start from config.yaml's `enabled` once the check has answered.
  const [on, setOn] = useState<AgentSwitches>({});
  const [picked, setPicked] = useState<string | null>(null);
  const firstSeen = useRef<Record<string, StartAgent["status"]>>({});
  useEffect(() => {
    if (!drafts || status.isPending) return;
    // A row the latest check no longer lists keeps its switch, so it comes back as the person left it.
    setOn(before => ({ ...before, ...Object.fromEntries(rows.map(row => {
      if (row.status === "checking") return [row.name, before[row.name] ?? false];
      const was = firstSeen.current[row.name];
      firstSeen.current[row.name] ??= row.status;
      if (!canWork(row)) return [row.name, false];
      // At first, config.yaml's choice; a kind it does not list starts on only when it is signed in.
      if (was === undefined) return [row.name, row.configured ? drafts.agents.find(agent => agent.name === row.name)?.enabled ?? true : row.status === "ready"];
      // One that became usable after the first look (signed in, or installed, then checked again) is switched on.
      return [row.name, canWork({ status: was }) ? before[row.name] ?? true : before[row.name] || was === "signedOut" || was === "missing"];
    })) }));
  }, [drafts, rows]);
  const initialized = rows.every(row => row.status !== "checking" && firstSeen.current[row.name] !== undefined);
  const readFailure = [settings, status, telemetry.status].find(read => read.isError);
  const prepared = !!drafts && !status.isPending && initialized && !!telemetry.status.data;
  const usable = usableAgents(rows, on);
  const first = firstAgentOf(usable, picked);
  // Asked here until it is answered; a changed consent version is asked again here as well.
  const asksConsent = telemetry.status.data?.state === "not_asked" || telemetry.status.data?.state === "needs_reask";
  // Ticked at first; it is saved only once the person goes on, whichever way they leave it.
  const [consent, setConsent] = useState(true);
  const [failure, setFailure] = useState<Failure>(null);
  const [busy, setBusy] = useState(false);

  const fail = (at: NonNullable<Failure>["at"], error: unknown) => {
    recordFailure(error, ["setup", at].join(": "));
    setFailure({ at, detail: problemText(error) });
  };
  /** Next, or on without an agent (`agents` false): the same saves in the same order. */
  const next = async (agents: boolean) => {
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      if (agents && drafts && loaded) {
        const chosen = chosenAgents(drafts.agents, rows, on, first);
        if (chosen) {
          const yaml = serverAgentsYaml({ limits: loaded.limits, agents: { ok: true, value: { ...drafts, agents: chosen } } });
          if (!yaml.ok) throw new Error("Invalid agent settings");
          try { await save.mutateAsync({ yaml: configYaml({ limits: loaded.limits, agents: { ok: true, value: drafts } }), agents: yaml.value, expected: loaded.hash! }); }
          catch (error) { fail("agents", error); void settings.refetch(); return; }
        }
        // The agent chosen here is where the next request starts, whatever this device picked before.
        forgetLaunchAgent();
      }
      if (asksConsent) {
        let refused: unknown = null;
        if (!await telemetry.choose(consent ? "on" : "off", error => { refused = error; })) { fail("consent", refused); return; }
      }
      onNext();
    } finally { setBusy(false); }
  };
  /** Looks at this PC's agents again; true once it has answered (the row then says what it found). */
  const recheck = async () => {
    setFailure(null);
    await client.refetchQueries({ queryKey: resources.agentStatus(root).queryKey });
    const after = client.getQueryState(resources.agentStatus(root).queryKey);
    if (after?.status === "error") { fail("check", after.error); return false; }
    return true;
  };
  if (settings.data?.error) return <ReadFailure what={t("agents.title")} error={new Error(settings.data.error.message)} retry={() => void settings.refetch()} />;
  if (readFailure) return <ReadFailure what={t("agents.title")} error={readFailure.error} retry={() => void readFailure.refetch()} />;
  if (!prepared) return <Loading />;
  const signed = rows.some(canWork);
  return <div data-setup-panel="agents">
    {/* Lines only between rows: what follows the list (a choice, the usage data, the buttons) draws its own. */}
    <ul className="m-0 -mt-3 list-none divide-y divide-line p-0">
      {rows.map(row => <AgentRow key={row.name} row={row} on={!!on[row.name]} name={agentDisplayName(row.name)}
        onChange={value => setOn(before => ({ ...before, [row.name]: value }))} onRecheck={recheck} checking={status.isFetching} />)}
    </ul>
    {/* After installing a CLI or signing in elsewhere, the list is looked at again from here. */}
    {rows.some(row => row.status === "missing" || row.status === "signedOut") && <div className="pt-1">
      <Button variant="quiet" data-setup-recheck disabled={status.isFetching} onClick={() => void recheck()}>{t("agents.recheck")}</Button>
    </div>}
    {failure?.at === "check" && <FailureLine text={t("agents.failed.check")} detail={failure.detail} />}
    {usable.length > 1 && <div role="radiogroup" aria-label={t("agents.first")}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-3 text-sm text-muted">
      <span>{t("agents.first")}</span>
      {usable.map(name => <button key={name} type="button" role="radio" aria-checked={first === name} onClick={() => setPicked(name)}
        className="inline-flex min-h-8 items-center gap-1.5 text-ink pointer-coarse:min-h-11">
        <span className={cn("size-4 flex-none rounded-full border-[1.5px] border-muted", first === name && "border-[5px] border-ink")} />
        {agentDisplayName(name)}</button>)}
    </div>}
    {!usable.length && <Message tone="caution" size="line" className="mt-4" data-setup-no-agent
      title={t(signed ? "agents.noneOnTitle" : "agents.noneReadyTitle")} description={t(signed ? "agents.noneOn" : "agents.noneReady")} />}
    {asksConsent && <Consent checked={consent} onChange={setConsent} />}
    <StepButtons failure={failure?.at === "agents" ? <FailureLine text={t("agents.failed.save")} detail={failure.detail} />
      : failure?.at === "consent" ? <FailureLine text={t("consent.failed")} detail={failure.detail} /> : null}
      other={!usable.length && !signed ? <Button variant="quiet" data-setup-without-agent disabled={busy} onClick={() => void next(false)}>{t("agents.continueWithout")}</Button> : null}>
      <Button data-setup-next className="min-h-11 px-6 narrow:w-full" disabled={busy || !usable.length} onClick={() => void next(true)}>{t("next")}</Button>
    </StepButtons>
  </div>;
}

/** Each kind's two letters in its row's mark. */
const MARKS: Record<string, string> = { codex: "Cx", claude: "Cl", grok: "Gk", copilot: "Gh", pi: "Pi" };

function AgentRow({ row, on, name, onChange, onRecheck, checking }: {
  row: StartAgent; on: boolean; name: string; onChange: (on: boolean) => void; onRecheck: () => Promise<boolean>; checking: boolean;
}) {
  const { t } = useTranslation("setup");
  const [how, setHow] = useState(false);
  // A check that answered and still found it signed out says so, so the press is seen to have looked.
  const [checked, setChecked] = useState(false);
  const ready = canWork(row);
  const mark = MARKS[row.adapter ?? ""] ?? (name.slice(0, 1).toUpperCase() + name.slice(1, 2));
  return <li data-setup-agent={row.name} data-setup-agent-status={row.status} className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 py-3">
    <span aria-hidden className="grid size-10 place-items-center rounded-md bg-hover text-sm font-semibold">{mark}</span>
    <span className="min-w-0">
      <span className="block font-semibold">{name}</span>
      <span className={cn("flex items-baseline gap-1.5 text-sm text-muted", row.status === "ready" && "text-done", row.status === "missing" && "text-soft")}>
        <i className="size-1.5 flex-none -translate-y-px rounded-full bg-current" />
        <span className="min-w-0 [word-break:auto-phrase]">{row.status === "missing" ? t("agents.missing", { command: row.command ?? row.name })
          : t(row.status === "ready" ? "agents.ready" : row.status === "found" ? "agents.found" : row.status === "checking" ? "agents.checking" : "agents.signedOut")}</span></span>
    </span>
    {/* On a phone the way to sign in goes under its state, which keeps the row's width to say it whole. */}
    {/* The switch says in words which way it is, and the word switches it too. */}
    {/* A phone puts the word under the switch, which leaves the row's width to the state beside it. */}
    {ready ? <label className="inline-flex min-h-8 cursor-pointer items-center gap-2.5 text-sm narrow:flex-col-reverse narrow:gap-1">
      <span aria-hidden data-setup-agent-switch-state className={cn("min-w-[3em] text-right narrow:min-w-0 narrow:text-xs", on ? "font-semibold text-ink" : "text-soft")}>{t(on ? "agents.on" : "agents.off")}</span>
      <Switch checked={on} onCheckedChange={onChange} aria-label={name} /></label>
      : row.status === "signedOut" && <Button variant="outline" className="min-h-10 px-4 text-base pointer-coarse:min-h-11 narrow:col-[2/-1] narrow:justify-self-start" aria-expanded={how} onClick={() => setHow(open => !open)}>{t("agents.enable")}</Button>}
    {!ready && how && <div className="col-[2/-1] -mt-2 rounded-md bg-bg px-4 py-3 text-sm text-muted">
      {t("agents.how")}
      {row.signIn && <div className="my-2 flex items-center gap-2 rounded-sm border-hairline border-lit-line bg-lit px-3 py-2 font-mono text-sm text-ink [overflow-wrap:anywhere]">
        {row.signIn}<CopyButton clip={() => textClip(row.signIn!)} label={t("agents.copy")} className="ml-auto" /></div>}
      <div className="mt-2">
        <Button variant="outline" disabled={checking} onClick={() => { setChecked(false); void onRecheck().then(setChecked); }}>{t("agents.recheck")}</Button>
      </div>
      {checked && row.status === "signedOut" && <p data-setup-still-signed-out role="status" className="mt-2 mb-0 text-sm text-turn [word-break:auto-phrase]">
        {t("agents.stillSignedOut", { name })}</p>}
    </div>}
  </li>;
}

function Consent({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  const { t } = useTranslation("setup");
  const id = useId();
  const [open, setOpen] = useState(false);
  const rows = [[t("consent.rows.sentKey"), t("consent.rows.sent")], [t("consent.rows.notSentKey"), t("consent.rows.notSent")],
    [t("consent.rows.idKey"), t("consent.rows.id")], [t("consent.rows.intervalKey"), t("consent.rows.interval")], [t("consent.rows.stopKey"), t("consent.rows.stop")]];
  return <div data-setup-consent className="mt-5 grid grid-cols-[22px_minmax(0,1fr)] items-start gap-3">
    <input id={id} type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="mt-0.75 size-4.5 cursor-pointer accent-ink" />
    <label htmlFor={id} className="cursor-pointer font-semibold">{t("consent.label")}</label>
    <p className="col-start-2 m-0 text-sm text-muted [word-break:auto-phrase]">{t("consent.body")} <button type="button" className="inline-link" aria-expanded={open}
      onClick={() => setOpen(was => !was)}>{t(open ? "consent.close" : "consent.detail")}</button></p>
    {open && <div className="col-start-2">
      <dl className="m-0 mt-2 border-t border-line text-sm">
        {rows.map(([key, value]) => <div key={key} className="grid grid-cols-[7.5em_minmax(0,1fr)] gap-3 border-b border-line py-2">
          <dt className="text-soft">{key}</dt><dd className="m-0">{value}</dd></div>)}
      </dl>
      <p className="mt-3 mb-0 text-sm"><TelemetryDetailsLink /></p>
    </div>}
  </div>;
}
