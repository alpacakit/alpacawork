import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { PendingRegion, ReadFailure } from "@/components/ui/loadable";
import { cn } from "@/lib/utils";
import { formatClock } from "@/domain/time";
import { usePrefetch } from "@/data/prefetch";
import { useTaskCardOn } from "@/features/coordinator/TaskCard";
import { followTask } from "@/features/coordinator/follow-task";
import { useMadeTaskState, useRunDetail, useRunStop } from "./data";
import type { Automation, Facts, Operation, Run, RunDetail } from "./shape";
import { operationText, outcomeWord, runLine, usd } from "./words";

/**
 * The tasks a run made, right after its line: each by its ID (pointed at, its card; pressed, opened over the screen)
 * and its state now, so what came of the run is read where the run is.
 */
export function RunTasks({ run }: { run: Pick<Run, "tasks"> }) {
  if (!run.tasks.length) return null;
  return <>{run.tasks.map(task => <RunTask key={task.id} task={task} />)}</>;
}

function RunTask({ task }: { task: Run["tasks"][number] }) {
  const { t } = useTranslation("automations");
  const prefetch = usePrefetch(task.id);
  const state = useMadeTaskState(task);
  const { anchor, trigger, card } = useTaskCardOn<HTMLButtonElement>(task.id, () => followTask(task.id), { opens: true });
  return <span className="ms-2 inline-flex items-baseline gap-1 whitespace-nowrap">
    <Button ref={anchor} variant="ref" data-automation-run-task={task.id} data-task-reference={task.id} className="relative z-1 text-xs" {...prefetch} {...trigger}>{task.id}</Button>{card}
    {state && <span data-automation-task-state className="text-xs text-muted">{t(`event.${state}` as never)}</span>}
  </span>;
}

/**
 * One run of the automation open, one line: its time, its outcome in a word (a failure in red), and its line (what it
 * did, why it was skipped or failed) with the tasks it made. Pressed, it opens what is kept of it under the line.
 */
export function RunRow({ automation, run, facts }: { automation: string; run: Run; facts: Facts }) {
  const { t } = useTranslation("automations");
  const [open, setOpen] = useState(false);
  const line = runLine(t, run);
  const failed = run.state === "failed";
  return <li data-automation-run={run.number} data-run-state={run.state} className="border-b border-rule">
    <div className="relative grid grid-cols-[3.25rem_auto_minmax(0,1fr)] items-baseline gap-x-3 py-2.5 text-sm narrow:grid-cols-[2.75rem_auto_minmax(0,1fr)] narrow:py-3">
      <span className="tabular-nums">{formatClock(run.at)}</span>
      <span className={cn("text-xs whitespace-nowrap", failed ? "font-semibold text-error" : "text-muted")}>{outcomeWord(t, run)}
        {run.kind === "trial" && <span data-automation-trial className="ms-1 text-muted">{t("runs.trial")}</span>}</span>
      <span className={cn("min-w-0 [overflow-wrap:anywhere]", run.state === "skipped" && "text-muted")}>
        <button type="button" data-automation-run-open aria-expanded={open} onClick={() => setOpen(!open)}
          className="text-start after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
          {line ?? t("runs.noLine")}</button>
        <RunTasks run={run} />
        {run.phase && run.phase !== "stopping" && <StopRun automation={automation} run={run} />}
      </span>
    </div>
    {open && <RunOpened automation={automation} run={run} facts={facts} />}
  </li>;
}

/** Stopping a run where it is: only one in `trigger` or `run` (one stopping says so already). */
function StopRun({ automation, run }: { automation: string; run: Run }) {
  const { t } = useTranslation("automations");
  const stop = useRunStop();
  return <Button variant="outline" data-automation-run-stop disabled={stop.isPending} className="relative z-1 ms-2 h-7 narrow:h-9"
    onClick={() => stop.mutate({ automation, run })}>{t("runs.stop")}</Button>;
}

/**
 * What is kept of one run, read when it is opened: what arrived (as names and values), whether `trigger` let it through,
 * what each short question to an AI answered, what alpacawork did for it, and the end of what it printed (on a press).
 * At most five lines.
 */
function RunOpened({ automation, run, facts }: { automation: string; run: Run; facts: Facts }) {
  const { t } = useTranslation("automations");
  const detail = useRunDetail(automation, run, true);
  return <div data-automation-run-detail className="mb-3 ms-[3.25rem] rounded-md border border-line p-3 text-sm narrow:ms-0">
    {detail.error ? <ReadFailure what={t("runs.detailFailed")} error={detail.error} retry={() => detail.refetch()} />
      : !detail.data ? <PendingRegion pending shape="rows" />
      : <RunFacts run={detail.data} facts={facts} />}
  </div>;
}

/** The lines of a run opened, as names and values beside each other (one above the other on a phone). */
function RunFacts({ run, facts }: { run: RunDetail; facts: Facts }) {
  const { t } = useTranslation("automations");
  const [output, setOutput] = useState(false);
  const asks = run.operations.filter(operation => operation.name === "ai.ask");
  const done = run.operations.filter(operation => operation.name !== "ai.ask" && !operation.name.startsWith("tasks.list") && !operation.name.endsWith(".read"));
  return <dl className="m-0 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 narrow:grid-cols-1 narrow:gap-y-0.5">
    {!!run.event.fields?.length && <Fact name={t("runs.arrived")}><Fields fields={run.event.fields} kind={run.event.kind} /></Fact>}
    {run.trigger && <Fact name={t("runs.passes")}>{t(run.trigger.run ? "runs.passed" : "runs.notPassed", { reason: run.trigger.reason })}</Fact>}
    {asks.map((operation, at) => <Fact key={at} name={t("runs.judged")}>{askText(t, operation)}</Fact>)}
    {(done.length > 0 || run.state === "done") && <Fact name={t("runs.didFor")}>
      {done.length ? done.map((operation, at) => <p key={at} className="m-0">{operationText(t, operation, facts)}</p>) : t("runs.didNothing")}</Fact>}
    {run.error && <Fact name={t("runs.error")}><span className="text-error">{run.error.message}</span>
      {run.error.file && <span className="ms-1 font-mono text-xs text-muted">{run.error.file}{run.error.line ? `:${run.error.line}` : ""}</span>}</Fact>}
    {run.report && <Fact name={t("runs.report")}><p className="m-0 whitespace-pre-wrap">{run.report}</p></Fact>}
    {run.output && (run.output.stdout || run.output.stderr) && <Fact name="">
      <Button variant="ref" data-automation-run-output aria-expanded={output} onClick={() => setOutput(!output)}>{t(output ? "runs.outputHide" : "runs.output")}</Button>
      {output && <pre className="m-0 mt-1 max-h-72 overflow-auto rounded-md bg-hover p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
        {run.output.stdout}{run.output.stderr && <span className="text-error">{run.output.stderr}</span>}</pre>}
    </Fact>}
  </dl>;
}

/**
 * What a short question to an AI answered, as it came (the program decides its shape: names and values, or a line),
 * with the model, how long it took and what it cost.
 */
export function askText(t: ReturnType<typeof useTranslation<"automations">>["t"], operation: Operation): string {
  const result = operation.result;
  const answer = result === null || result === undefined ? "" : typeof result === "object" && !Array.isArray(result)
    ? Object.entries(result as Record<string, unknown>).filter(([name]) => name !== "durationMs").map(([name, value]) => `${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(t("join"))
    : typeof result === "string" ? result : JSON.stringify(result);
  const took = (result as { durationMs?: unknown } | null)?.durationMs;
  const seconds = typeof took === "number" ? t("runs.seconds", { seconds: (took / 1000).toFixed(1) }) : null;
  const cost = operation.usage?.costUsd != null ? `$${usd(operation.usage.costUsd)}` : null;
  return [answer, operation.usage?.model, seconds, cost].filter(Boolean).join(t("join"));
}

export function Fact({ name, children }: { name: string; children: ReactNode }) {
  return <><dt className="text-muted">{name}</dt><dd className="m-0 min-w-0 [overflow-wrap:anywhere] narrow:mb-1.5">{children}</dd></>;
}

/**
 * An event's fields as words: a task's state changing, words on a task, the PC's pressure, a time are the server's
 * fields, said in the screen's words; a signal's data is its sender's, said as it came.
 */
export function fieldWords(t: ReturnType<typeof useTranslation<"automations">>["t"], kind: string, [name, value]: readonly [string, string]): [string, string] {
  if (kind === "signal") return [name, value];
  const say = (key: string) => (t as unknown as (key: string, options?: object) => string)(key, { defaultValue: "" });
  const label = say(`field.${name}`) || name;
  const words = name === "from" || name === "to" ? say(`event.${value}`) : name === "by" ? say(`field.by_${value}`) : name === "type" ? say(`trigger.kind.${value}`)
    : name === "kinds" ? value.split(", ").map(kind => say(`pressure.${kind}`) || kind).join(t("pressure.join"))
    : name === "phase" ? say(`field.phase_${value}`) : name === "scheduledAt" ? formatClock(value) : "";
  return [label, words || value];
}
export const fieldsText = (t: ReturnType<typeof useTranslation<"automations">>["t"], kind: string, fields: readonly (readonly [string, string])[]) =>
  fields.map(field => fieldWords(t, kind, field)).map(([name, value]) => `${name}${t("colon")}${value}`).join(t("join"));

/** What arrived, a name and its value a line, as code is set. */
export function Fields({ fields, kind = "signal" }: { fields: readonly (readonly [string, string])[]; kind?: string }) {
  const { t } = useTranslation("automations");
  return <div className={cn("text-xs", kind === "signal" && "font-mono")}>{fields.map(field => fieldWords(t, kind, field)).map(([name, value]) =>
    <div key={name} className="[overflow-wrap:anywhere]">{name}{t("colon")}{value}</div>)}</div>;
}

/** What it would do, a line, and for a task it would make the head of its instruction under it. */
export function IntentLine({ operation, automation }: { operation: Operation; automation: Pick<Automation, "latest"> }) {
  const { t } = useTranslation("automations");
  const input = (operation.input ?? {}) as Record<string, unknown>;
  const instruction = typeof input.instruction === "string" ? input.instruction : null;
  return <div className="mb-1">
    <p className="m-0">{operationText(t, operation, automation.latest.facts)}</p>
    {instruction && <p className="m-0 line-clamp-3 text-xs text-muted">{t("band.instruction", { text: instruction })}</p>}
  </div>;
}

