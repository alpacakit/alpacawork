import { useQueryClient } from '@tanstack/react-query';
import { isComposingKey } from "@/components/ui/composing";
import { Trans, useTranslation } from "react-i18next";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Controller } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popup } from "@/components/ui/popup";
import { TaskId } from "@/components/ui/task-id";
import { StateIcon } from "@/components/ui/state-label";
import { MENU_GROUP, MenuTick, menuRow } from "@/components/ui/menu-rows";
import { useStateLook } from "@/components/ui/tone";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useReaderPeople } from "@/data/queries";
import type { Task, TaskState } from "@/data/types";
import { FieldError } from "@/components/ui/field";
import { REPORT_STATE, type StateChoice } from "@/domain/tasks";
import { closeInput, openInput, useOpenInput } from "@/state/open-input";
import { cn } from "@/lib/utils";
import { useTaskReportTarget, captureReportOpening, useReportOpeningDisabled } from "@/features/reader/use-task-report";
import { retainedInput, useCheckShownHere, useWriteIntentStore } from "@/data/write-intent";
import { reportDefaults, taskReportTarget, sameTaskReportTarget } from "@/data/task-report";
import { afterSave } from "./drafts";
import { InlineForm } from "./InlineForm";
import { useReaderCard, type ReaderCard } from "@/features/reader/next-question";
import { FormField, useServerForm } from "./server-form";

/** The state a choice asks for: Review OK finishes, Hold holds, Restore returns to what was held, Stop stops. */
const leadsTo = (task: Task, choice: StateChoice): TaskState =>
  choice === "unhold" ? task.baseState : REPORT_STATE[choice];

/** A state's word, as the state label says it. */
function StateWord({ state }: { state: TaskState }) {
  return <span className="min-w-0 flex-1 truncate">{useStateLook(state).word}</span>;
}

/** The choices as a menu's rows (components/ui/menu-rows): the picked one ticked and filled; ↑ ↓ move it. */
function StateChoices({ task, choices, value, onChange, disabled }: {
  task: Task; choices: StateChoice[]; value: StateChoice; onChange: (choice: StateChoice) => void; disabled: boolean;
}) {
  const { t } = useTranslation("forms");
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposingKey(event)) return;
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step || disabled || !choices.length) return;
    event.preventDefault();
    const next = choices[(choices.indexOf(value) + step + choices.length) % choices.length]!;
    onChange(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-state-choice="${next}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={t("reportForm.statePick")} onKeyDown={move} className="-mx-2 flex flex-col">
      {choices.map((choice) => {
        const checked = choice === value, state = leadsTo(task, choice);
        return (
          <button key={choice} type="button" role="radio" aria-checked={checked} data-state-choice={choice}
            tabIndex={checked ? 0 : -1} disabled={disabled} onClick={() => onChange(choice)} className={menuRow(checked)}>
            <MenuTick checked={checked} />
            <StateIcon state={state} className="size-3.5 flex-none" />
            <StateWord state={state} />
          </button>
        );
      })}
    </div>
  );
}

/** The person's words that go with the choice; either may be emptied, and is then sent as the choice's default (reportRequest). */
const reportSchema = z.object({ choice: z.custom<StateChoice>(), title: z.string(), description: z.string() });

/** The report's fields stand under one group name (MENU_GROUP), so each field's own label is only read out. Its rule
 * reaches the surface's edges: the popover's room (p-3) or the sheet's (p-4). */
const REPORT_FIELD = "m-0 [&>label]:sr-only";

/** State reports go directly as the person, with separate title/body and the versions they saw. */
function ReportFields({ task, id, answerCard }: { task: Task; id: string; answerCard: ReaderCard | null }) {
  const { t } = useTranslation("forms");
  const people = useReaderPeople(task.id);
  const client = useQueryClient(), current = taskReportTarget(task, people);
  const [opening, setOpening] = useState(() => captureReportOpening(client, current));
  const report = useTaskReportTarget(opening, answerCard);
  const ready = report.selectable;
  useCheckShownHere(report.key, report.status === 'unconfirmed');
  const restored = retainedInput(useWriteIntentStore.getState().entries[report.key])?.draft;
  const choices = current.facts.choices;
  // The fields open with the choice's own words, as values to send or to write over; a refused draft comes back as written.
  const choice = (restored?.choice as StateChoice | undefined) ?? choices[0];
  const words = choice ? reportDefaults(choice) : { title: "", description: "" };
  // The fields the person has written in stay as written, an emptied one too; the others follow the choice. Only those
  // go as their words, so a refused report's draft keeps them apart (the rest are the choice's defaults, reportRequest).
  const [written] = useState(() => new Set((["title", "description"] as const).filter(name => restored?.[name] !== undefined)));
  const form = useServerForm<z.infer<typeof reportSchema>>({ schema: reportSchema, fieldPaths: ["title", "description"],
    defaultValues: { choice, title: restored?.title ?? words.title, description: restored?.description ?? words.description },
    submit: async ({ choice, title, description }) => {
      if (!sameTaskReportTarget(opening.target, current) || !opening.target.facts.choices.includes(choice)) { form.setError("choice", { type: "stale", message: t("reportForm.chooseAgain") }); return false; }
      const saved = afterSave(closeInput);
      const sent = report.submit(choice, { ...written.has("title") && { title }, ...written.has("description") && { description } });
      if (sent.admission === 'rejected') { form.setError('root.server', { message: sent.reason.displayMessage }); return false; }
      saved();
    },
  });
  return (
    <InlineForm submitLabel={t("reportForm.submit")} error={form.formState.errors.root?.server?.message}
      pending={form.formState.isSubmitting} disabled={!ready || !choices.length}
      note={report.unproven ? t('writeFailure.unproven') : report.status === 'unconfirmed' ? <Button type="button" variant="outline" onClick={() => { const saved = afterSave(closeInput); void report.check().then(saved, () => {}); }}>{t('reader:recovery.check')}</Button> : undefined}
      onSubmit={() => void form.save()} onCancel={closeInput}>
      <Controller control={form.control} name="choice" render={({ field, fieldState }) => <>
        <StateChoices task={task} choices={choices} value={field.value} onChange={choice => {
          setOpening(captureReportOpening(client, current)); form.clearErrors("choice");
          const words = reportDefaults(choice);
          for (const name of ["title", "description"] as const) if (!written.has(name)) form.setValue(name, words[name]);
          field.onChange(choice);
        }} disabled={!ready} />
        {fieldState.error?.message && <FieldError className="mt-1">{fieldState.error.message}</FieldError>}
      </>} />
      <div role="group" aria-labelledby={`${id}-words`} className="-mx-3 mt-2 flex flex-col gap-2 border-t border-line px-3 pt-1 in-data-[slot=sheet]:-mx-4 in-data-[slot=sheet]:px-4">
        <div id={`${id}-words`} className={cn(MENU_GROUP, "-mx-2")}>{t("reportForm.words")}</div>
        <FormField form={form} name="title" label={t("reportForm.reportTitle")} id={`${id}-title`} className={REPORT_FIELD}>
          {field => <Input {...field} onChange={event => { written.add("title"); field.onChange(event); }} placeholder={t("reportForm.reportTitleHint")} />}
        </FormField>
        <FormField form={form} name="description" label={t("reportForm.reportDescription")} id={`${id}-description`} className={REPORT_FIELD}>
          {field => <Textarea {...field} onChange={event => { written.add("description"); field.onChange(event); }} placeholder={t("reportForm.reportDescriptionHint")} className="min-h-16" />}
        </FormField>
      </div>
    </InlineForm>
  );
}

/**
 * The reader's one state form, whatever opens it (R, Change state). It stands in one place (the reader keeps it unseen at
 * its foot, TaskActions), so what is typed in it stays when the opener shown changes; it grows out of the opener that is
 * shown (`anchorRef`), else out of its own control. On a phone it comes up as a sheet. Its heading names the task it
 * changes, since its opener may stand far from the task's own title.
 */
export function StateControl({ task, anchorRef }: { task: Task; anchorRef?: RefObject<HTMLElement | null> }) {
  const { t } = useTranslation("forms");
  const card = useReaderCard();
  const opened = useOpenInput("report", task.id);
  const open = opened !== null;
  const writeDisabled = useReportOpeningDisabled(task.id);
  const own = useRef<HTMLButtonElement>(null);
  const [at] = useState(() => ({ get current() { return anchorRef?.current ?? own.current; } }));
  return (
    <Popup open={open} onOpenChange={(next) => !next && closeInput()} label={t("reportForm.heading", { id: task.id })} align="end"
      heading={<Trans defaults={t("reportForm.heading", { id: "<id/>" })} components={{ id: <TaskId id={task.id} className="font-medium tabular-nums text-muted" /> }} />} anchorRef={at}
      className="w-88 origin-(--radix-popover-content-transform-origin) animate-grow data-[side=top]:animate-grow"
      anchor={<button ref={own} type="button" data-state-anchor data-input-opener aria-expanded={open} disabled={writeDisabled}
        onClick={(event) => { event.stopPropagation(); openInput({ form: "report", taskId: task.id, answerCard: card }); }}>
        <Icon name="state" className="size-4 text-muted" />{t("reportForm.statePick")}<Icon name="down" className="size-3 text-muted" />
      </button>}>
      {opened && <ReportFields task={task} id="report-reader" answerCard={opened.answerCard ?? null} />}
    </Popup>
  );
}
