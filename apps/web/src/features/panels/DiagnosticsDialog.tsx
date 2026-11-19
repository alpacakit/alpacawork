import { readProblemText } from "@/data/client";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Message } from "@/components/ui/message";
import { StatusDot } from "@/components/ui/status-dot";
import { SummaryGrid } from "@/components/ui/summary-grid";
import { useConnection } from "@/data/connection";
import { useShelved, useTasks, useWorkspaceInfo } from "@/data/queries";
import { formatDayTime } from "@/domain/time";
import { PanelDialog } from "./PanelDialog";

/** The diagnostics' labels are longer than the summary's. Both tables keep one label column, so their values start at one edge; a value wraps. */
const labelsFit = "grid-cols-[11rem_minmax(0,1fr)] narrow:grid-cols-[11rem_minmax(0,1fr)]";
/** Each group starts with room above its heading, as the facts above it end. */
const heading = "mt-type-section mb-type-close text-md font-semibold";

export function DiagnosticsDialog() {
  const { t, i18n } = useTranslation("panels");
  const info = useWorkspaceInfo();
  const lastReceivedAt = useConnection((state) => state.lastReceivedAt);
  const tasks = useTasks();
  const shelved = useShelved();
  // Retained unreadable tasks are displayed, but are absent from the current tree.
  const taskIds = new Set([...tasks, ...shelved.map((item) => item.task)].filter((task) => !info.staleIds.includes(task.id)).map((task) => task.id));
  const orphanRuns = info.runs.filter((run) => !taskIds.has(run.taskId));
  const connection = useConnection();
  const states = { connecting: t("diagnostics.connecting"), live: t("diagnostics.receiving"),
    reconnecting: t("diagnostics.reconnecting"), stopped: t("diagnostics.stopped") };
  const yesNo = (value: boolean) => value ? t("diagnostics.yes") : t("diagnostics.no");
  return (
    <PanelDialog title={t("diagnostics.title")} description={t("diagnostics.description")}>
      <div className="mt-1 mb-4 flex items-center gap-2">
        <StatusDot stopped={connection.offline} />
        <strong className="font-medium">{states[connection.state]}</strong>
      </div>
      {connection.state !== "live" && <p className="mb-4 text-sm text-muted">{connection.message()}</p>}
      <SummaryGrid className={labelsFit}>
        <dt>{t("diagnostics.facts.lastReceived")}</dt>
        <dd>{formatDayTime(lastReceivedAt === undefined ? "" : new Date(lastReceivedAt).toISOString(), i18n.language)}</dd>
        <dt>{t("diagnostics.facts.tasks")}</dt>
        <dd>{t("diagnostics.facts.tasksShown", { n: tasks.length })}</dd>
        <dt>{t("diagnostics.facts.root")}</dt>
        <dd data-workspace-root className="font-mono text-sm [overflow-wrap:anywhere]">{info.root}</dd>
        <dt>{t("diagnostics.facts.writable")}</dt><dd>{yesNo(info.writable)}</dd>
      </SummaryGrid>
      {connection.offline && <Button variant="outline" onClick={connection.reconnect}>{t("diagnostics.reconnect")}</Button>}
      <h3 className={heading}>{t("diagnostics.errors")}</h3>
      {info.errors.length ? <ul className="flex flex-col gap-1.5">{info.errors.map((error, index) => (
        <li key={`${error.path}:${index}`}><Message quiet tone="error" size="line" title={<>{error.path && <><code>{error.path}</code>: </>}{readProblemText(error)}</>} /></li>
      ))}</ul> : <Message tone="empty" size="line" title={t("diagnostics.none")} />}
      <h3 className={heading}>{t("diagnostics.staleTasks")}</h3>
      <p className="mb-type-close text-xs text-muted">{t("diagnostics.staleHint")}</p>
      {info.staleIds.length ? <ul>{info.staleIds.map((id) => <li key={id}>{id}</li>)}</ul> : <Message tone="empty" size="line" title={t("diagnostics.none")} />}
      <h3 className={heading}>{t("diagnostics.runs")}</h3>
      <SummaryGrid className={labelsFit}>
        <dt>{t("diagnostics.profiles")}</dt>
        <dd className={info.profiles.length ? undefined : "text-warn"}>{info.profiles.map(profile => profile.key).join(", ") || t("diagnostics.noProfiles")}</dd>
        <dt>{t("diagnostics.orphanRuns")}</dt>
        <dd>{orphanRuns.length ? orphanRuns.map((run) => <div key={run.id}>{t("diagnostics.orphanRun", { run: run.id, task: run.taskId })}</div>) : t("diagnostics.none")}</dd>
      </SummaryGrid>
    </PanelDialog>
  );
}
