import { formProblemText } from './problem-text';
import { acceptFormWrite } from './accept-write';
import { admitDirectIntent } from '@/data/direct-write';
import { rowWriteBasis } from "@/data/connection";
import { useMemo, useState } from "react";
import { z } from "zod";
import { Trans, useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { useQueryClient } from "@tanstack/react-query";
import { agentAssignInput, agentHandoverInput } from "@alpacawork/contract/inputs";
import { FieldError } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Message } from "@/components/ui/message";
import { useReaderPeople, useWriteDisabled } from "@/data/queries";
import { useWorkspaceInfo } from "@/data/queries";
import { intentKey, useWriteIntent } from "@/data/write-intent";
import type { Task } from "@/data/types";
import { crewOf, indexPeople } from "@/domain/people";
import { placementAgentLabel, selectionAgentLabels } from "@/domain/agent-label";
import { AgentLabel } from "@/features/people/AgentLabel";
import { closeInput, useFocusBack, useOpenInput } from "@/state/open-input";
import { InlineForm, INPUT_SECTION } from "./InlineForm";
import { FormError, useServerForm } from "./server-form";
import { AgentChoiceFields, useAgentChoice } from "./AgentChoice";
import { useRereadActiveTask } from "./reread-active-task";

type ResponsiblePayload = { task: string; expectedTaskHash: string; agent?: string; role?: "responsible";
  profile?: string; selected?: string; replace?: string; expectedPlacementRevision?: number };

/**
 * Where the screen offers to decide a task's responsible (the A key): only on a task right below its project (the
 * list's top); one further down is its parent's responsible's to place. The server refuses the rest.
 */
export const placesResponsible = (task: Pick<Task, "kind" | "parent">) => task.kind === "task" && task.parent === null;

/**
 * The section under the reader's panes where a person decides who is
 * responsible for a task right below its project (`placesResponsible`): a current member takes over, or a new person
 * is placed with a configured launch profile and the model and effort it starts with (kept by the server with the
 * placement), replacing the current
 * responsible person (who stays as history, never as a member). Checked
 * against the task's hash and the placement's revision as shown.
 */
export function ResponsibleSection({ task }: { task: Task }) {
  const open = useOpenInput("responsible", task.id) !== null;
  useFocusBack(open, "[data-opens=responsible]");
  return open ? <ResponsibleFields task={task} /> : null;
}

function ResponsibleFields({ task }: { task: Task }) {
  const { t } = useTranslation("forms");
  const people = useReaderPeople(task.id);

  const client = useQueryClient();
  const rereadTask = useRereadActiveTask(task.id);
  const root = useWorkspaceInfo(info => info.root);
  const intent = useWriteIntent<ResponsiblePayload, unknown>(intentKey(root, "responsible", task.id));
  const kept = intent.retainedInput?.payload;
  const agent = useAgentChoice(kept?.profile ? { profile: kept.profile, selected: JSON.parse(kept.selected ?? '{}') } : undefined);
  const [opening, setOpening] = useState(() => ({ hash: kept?.expectedTaskHash ?? task.hash, ...crewOf(task.id, people) }));
  const { responsible, members } = opening;
  // Labels include translated launch status; a language change also changes t.
  const memberLabels = useMemo(() => selectionAgentLabels(members, people), [members, people, t]);
  const basis = rowWriteBasis(task.id);
  const denied = useWriteDisabled(basis);
  const commandFor = (value: { agent: string; profile: string }): {
    path: "agent/handover" | "agent/assign"; payload: ResponsiblePayload;
  } => {
    const member = members.find(each => each.id === value.agent);
    return member
      ? { path: "agent/handover", payload: { task: task.id, agent: member.id,
          expectedTaskHash: opening.hash, expectedPlacementRevision: member.revision } }
      : { path: "agent/assign", payload: { task: task.id, role: "responsible",
          profile: value.profile, selected: JSON.stringify(agent.send), expectedTaskHash: opening.hash,
          ...(responsible ? { replace: responsible.id, expectedPlacementRevision: responsible.revision } : {}) } };
  };
  const schema = z.object({ agent: z.string(), profile: z.string() }).superRefine((value, context) => {
    const command = commandFor(value);
    const checked = command.path === "agent/handover"
      ? agentHandoverInput.safeParse(command.payload) : agentAssignInput.safeParse(command.payload);
    if (!checked.success) for (const issue of checked.error.issues)
      if (["agent", "profile"].includes(String(issue.path[0]))) context.addIssue({ ...issue });
  });
  const form = useServerForm({ schema,
    defaultValues: { agent: intent.retainedInput?.draft?.agent ?? members[0]?.id ?? "new", profile: intent.retainedInput?.draft?.profile ?? agent.profile },
    submit: async value => {
      if (intent.status === "pending" || intent.status === "unconfirmed" || intent.status === "conflict") return false;
      if (value.agent === "new" && !agent.ready) return false;
      const command = commandFor(value);
      return acceptFormWrite(admitDirectIntent(client, intentKey(root, 'responsible', task.id),
        { path: command.path, response: 'placement', label: task.title, outcomes: 'all' }, () => command.payload, basis, { draft: value }), closeInput);
    },
  });
  const choice = form.watch("agent");
  const reread = async () => {
    const read = await rereadTask();
    if (!read) return;
    const { latest, row } = read;
    const crew = crewOf(task.id, indexPeople(latest));
    const selected = form.getValues("agent");
    if (selected !== "new" && !crew.members.some(each => each.id === selected)
      || selected === "new" && !latest.profiles.some(each => each.key === form.getValues("profile"))) {
      notify.error(t("responsibleForm.choiceUnavailable")); closeInput(); return;
    }
    setOpening({ hash: row.hash, ...crew });
    if (intent.status === "unconfirmed") intent.conflict();
    intent.reset();
    form.clearFailure();
  };
  const linkedAgent = { ...agent,
    chooseProfile: (value: string) => { agent.chooseProfile(value); form.setValue("profile", value, { shouldValidate: form.formState.isSubmitted }); },
    issues: { profile: form.formState.errors.profile?.message },
  };
  return (
    <div data-responsible-section className={INPUT_SECTION}>
      <InlineForm submitLabel={responsible ? t("responsibleForm.change") : t("responsibleForm.decide")}
        error={(intent.failure && formProblemText(intent.failure))}
        pending={intent.status === "pending"} disabled={denied || form.blocked || intent.blocked || intent.status === "unconfirmed" || intent.status === "conflict"} onSubmit={() => void form.save()} onCancel={closeInput}
        note={responsible ? t("responsibleForm.replaceNote", { name: placementAgentLabel(responsible, people) }) : undefined}>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0 text-sm">
          <legend className="mb-1 text-xs text-muted">{t("responsibleForm.legend")}</legend>
          {members.map((member) => (
            <label key={member.id} className="flex min-w-0 items-center gap-2" title={memberLabels.get(member.id)!.full}>
              <input type="radio" name="responsible" value={member.id} checked={choice === member.id}
                aria-label={t("responsibleForm.promote", { name: memberLabels.get(member.id)!.full })}
                onChange={(event) => form.setValue("agent", event.target.value, { shouldValidate: form.formState.isSubmitted })} />
              <span className="min-w-0"><Trans defaults={t("responsibleForm.promote", { name: "<agent/>" })}
                components={{ agent: <AgentLabel label={memberLabels.get(member.id)!} /> }} /></span>
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="radio" name="responsible" value="new" checked={choice === "new"}
              onChange={(event) => form.setValue("agent", event.target.value, { shouldValidate: form.formState.isSubmitted })} />
            {t("responsibleForm.newPerson")}
          </label>
          {choice === "new" && (
            <div className="ml-6">
              <AgentChoiceFields choice={linkedAgent} />
              {!agent.profiles.length && <Message tone="caution" size="line" className="mt-2" title={t("responsibleForm.noProfiles")} />}
            </div>
          )}
          {form.formState.errors.agent?.message && <FieldError className="mt-0">{form.formState.errors.agent.message}</FieldError>}
        </fieldset>
        <FormError form={form} onReread={reread} />
        {(intent.status === "conflict" || intent.status === "unconfirmed") && !form.formState.errors.root?.server &&
          <FieldError className="mt-0 flex items-center gap-3">
            <span>{t(intent.status === "conflict" ? "writeFailure.conflict" : "writeFailure.unconfirmed")}</span>
            <Button variant="outline" onClick={() => void reread().catch(error => notify.failure(error, { about: "responsible: read latest" }))}>{t("writeFailure.readLatest")}</Button>
          </FieldError>}
      </InlineForm>
    </div>
  );
}
