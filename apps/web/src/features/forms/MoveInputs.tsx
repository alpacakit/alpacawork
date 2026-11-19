import { formProblemText } from './problem-text';
import { acceptFormWrite } from './accept-write';
import { admitDirectIntent } from '@/data/direct-write';
import { rowWriteBasis, workspaceWriteBasis, type WriteBasis } from "@/data/connection";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { useQueryClient } from "@tanstack/react-query";
import { taskMoveShape } from "@alpacawork/contract/inputs";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useWriteDisabled, useTaskIndex, useWorkspaceInfo } from "@/data/queries";
import { intentKey, useWriteIntent } from "@/data/write-intent";
import type { Task } from "@/data/types";
import { TASK_POLICY, evaluate } from "@alpacawork/contract/task-policy";
import type { TaskIndex } from "@/domain/tasks";
import { closeInput, useFocusBack, useOpenInput } from "@/state/open-input";
import { InlineForm, INPUT_SECTION } from "./InlineForm";
import { FormField, useServerForm } from "./server-form";
import { useRereadActiveTask } from "./reread-active-task";

/**
 * A task's parent as the server keeps it and a move names it: the task above it, or its project Task. The list's tree
 * leaves out the project right above a task (`parent` null), so there it is the task's `projectId`; a row names it.
 */
const parentOf = (parent: string | null, projectId: string) => parent ?? projectId;

/**
 * The parents a task can move under, all in its own project (a task does not leave it): its project Task, then any
 * active task of the project that is not itself or below it (no cycle) and that the finished-branch rule allows (no
 * unfinished task under a finished one), in tree order, labelled by its path. The backend checks the same, the parent's
 * responsible and the depth limit, against the version on screen.
 */
export function parentChoices(task: Task, index: TaskIndex): { id: string; label: string }[] {
  const project = index.byId.get(task.projectId);
  const out: { id: string; label: string }[] = project ? [{ id: project.id, label: project.title }] : [];
  const walk = (list: Task[], prefix?: string) => {
    for (const each of list) {
      // A skipped parent also removes its entire branch from the choices.
      if (each.id === task.id || evaluate(TASK_POLICY.parentChild, { parentBase: each.baseState, childBase: task.baseState, direction: "structure_insert" }).kind === "reject") continue;
      const label = prefix === undefined ? each.title : `${prefix} › ${each.title}`;
      out.push({ id: each.id, label });
      walk(index.children.get(each.id) ?? [], label);
    }
  };
  walk(index.roots.filter((each) => each.projectId === task.projectId));
  return out;
}

/**
 * Change parent: the task keeps its ID, folder and runs; only its
 * logical parent changes, within its project, and from then on its reports go to the new parent. A project Task does
 * not move.
 * Running work is not stopped. The form holds the version it was opened on:
 * a change made elsewhere is shown (the parent then and now) and a move
 * against it is refused; the person's choice is kept and "Choose again from the latest state"
 * moves the form on to the latest version for them to send again.
 */
export function MoveSection({ task }: { task: Task }) {
  const open = useOpenInput("move", task.id) !== null && task.kind === "task";
  useFocusBack(open, "[data-opens=move]");
  return open ? <MoveFields task={task} /> : null;
}

function MoveFields({ task }: { task: Task }) {
  const client = useQueryClient();
  const { t } = useTranslation("forms");
  const index = useTaskIndex();
  const choices = useMemo(() => parentChoices(task, index), [task, index]);
  const root = useWorkspaceInfo(info => info.root);
  const rereadTask = useRereadActiveTask(task.id);
  const intent = useWriteIntent<{ task: string; parent: string; expectedTaskHash: string }, unknown>(intentKey(root, "move", task.id));
  // The version the form was opened on: a move sends it, so a change made elsewhere since then is refused,
  // not overwritten. Only the person adopting the latest version moves the form on to it.
  const [opening, setOpening] = useState({ hash: intent.retainedInput?.payload.expectedTaskHash ?? task.hash, parent: intent.retainedInput?.draft?.openedParent ?? parentOf(task.parent, task.projectId) });
  const changedElsewhere = task.hash !== opening.hash;
  const form = useServerForm({ schema: taskMoveShape.pick({ parent: true }),
    defaultValues: { parent: intent.retainedInput?.draft?.parent ?? opening.parent },
    submit: async ({ parent }) => {
      if (parent === opening.parent || intent.status === "conflict" || intent.status === "unconfirmed") return false;
      return acceptFormWrite(admitDirectIntent(client, intentKey(root, 'move', task.id), { path: 'task/move', response: 'task', label: task.title, outcomes: 'all' },
        () => ({ task: task.id, expectedTaskHash: opening.hash, parent }), basis, { draft: { parent, openedParent: opening.parent } }), closeInput);
    },
  });
  const parent = form.watch("parent");
  const basis: WriteBasis = { ...workspaceWriteBasis(), kind: 'all', reads: [rowWriteBasis(task.id), rowWriteBasis(parent)] };
  const denied = useWriteDisabled(basis);
  const unchanged = parent === opening.parent;
  const titleOf = (id: string) => index.byId.get(id)?.title ?? id;
  // Adopting the latest version keeps the person's choice; they send it again themselves.
  const adopt = async () => {
    if (intent.status === "unconfirmed") {
      const read = await rereadTask();
      if (!read) return;
      const { row } = read;
      setOpening({ hash: row.hash, parent: parentOf(row.parentId, row.projectId) });
      intent.conflict();
    } else setOpening({ hash: task.hash, parent: parentOf(task.parent, task.projectId) });
    intent.reset(); form.clearFailure();
  };
  const stale = intent.status === "conflict" || intent.status === "unconfirmed";
  const notice = stale || changedElsewhere
    ? t(intent.status === "unconfirmed" ? "writeFailure.unconfirmed" : stale ? "moveForm.refused" : "moveForm.changedElsewhere", { opened: titleOf(opening.parent), current: titleOf(parentOf(task.parent, task.projectId)) })
    : undefined;
  return (
    <div data-move-section className={INPUT_SECTION}>
      <InlineForm submitLabel={t("moveForm.submit")} error={[notice, (intent.failure && formProblemText(intent.failure)), form.formState.errors.root?.server?.message].filter(Boolean).join(" ") || undefined} pending={intent.status === "pending"}
        disabled={denied || form.blocked || intent.blocked || unchanged || stale} onSubmit={() => void form.save()} onCancel={closeInput} note={t("moveForm.note")}>
        <FormField form={form} name="parent" id="move-parent" label={t("moveForm.parent")} className="my-0">
          {field => <NativeSelect {...field} className="w-full text-sm">
            {choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </NativeSelect>}
        </FormField>
        {(stale || changedElsewhere) && (
          <Button type="button" variant="outline" data-move-adopt className="mt-2" onClick={() => void adopt().catch(error => notify.failure(error, { about: "move: read latest" }))}>{t("moveForm.adopt")}</Button>
        )}
      </InlineForm>
    </div>
  );
}
