import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { ControlTaskHeadDTO } from "@alpacawork/contract/control";
import { retryOf } from "@/data/client";
import { rowWriteBasis, workspaceWriteBasis, type WriteBasis } from "@/data/connection";
import { useEveryTaskIndex, useTaskDetail, useWorkspaceInfo, useWriteDisabled } from "@/data/queries";
import { saveSchema, useTaskSchema } from "@/data/fields";
import type { WorkspaceInfo } from "@/data/types";
import { intentKey, useWriteIntent } from "@/data/write-intent";
import { useAnswerGuard } from "@/features/forms/answer-guard";
import { useServerForm } from "@/features/forms/server-form";
import { PROJECT_POLICY } from "@alpacawork/contract";
import { draftAfterResend, projectChange, projectDraftSchema, saveProject, schemaChanged, type ProjectDraft, type ProjectUpdate } from "./settings-draft";

export type Project = WorkspaceInfo["projects"][number];
/** What the draft was last read or saved as, and the project Task's hash a save expects. */
type Base = { hash: string; draft: ProjectDraft };

/**
 * A project's settings as a draft to save: what it starts from, what a save writes, and what a lost or refused save
 * leaves.
 *
 * Saving writes, each only when it changed: config.yaml's code location first (it leaves the Task's hash as it was
 * read), then the project's own fields (field use, so a field just added takes its value), then the Task once
 * (title, colour, the policy when it changed). Each says its own failure, so one may be saved while another is not.
 */
export function useProjectSave(project: Project) {
  const { t } = useTranslation("panels");
  const client = useQueryClient();
  const root = useWorkspaceInfo((info) => info.root);
  const writeDisabled = useWriteDisabled(project.id);
  const task = useEveryTaskIndex().byId.get(project.id);
  const { detail, query } = useTaskDetail(task);
  // The fields the project's Tasks use (field get at the project): its own value is its policy alone.
  const tasksSchema = useTaskSchema(project.id);
  const [base, setBase] = useState<Base | null>(null);
  const send = (input: ProjectUpdate, opId: string, basis?: WriteBasis) => saveProject(client, input, opId, basis);
  const taskIntent = useWriteIntent<ProjectUpdate, ControlTaskHeadDTO>(intentKey(root, "project-settings", project.id), body => ({ path: 'task/update', response: 'task', body }));
  const placeIntent = useWriteIntent<ProjectUpdate, ControlTaskHeadDTO>(intentKey(root, "project-location", project.id), body => ({ path: 'task/update', response: 'task', body }));
  // In the order they are written: the location first.
  const intents = [placeIntent, taskIntent];
  const busy = intents.some(({ status }) => status === "pending" || status === "unconfirmed");
  const form = useServerForm<ProjectDraft>({ schema: projectDraftSchema,
    submit: async (valid) => {
      if (base === null || writeDisabled || busy) return false;
      const answer = capture();
      const was = base.draft, sent = { ...valid, title: valid.title.trim(), cwd: valid.cwd.trim() };
      const change = projectChange(was, sent);
      // The location goes first: it writes config.yaml only, so the Task keeps the hash both writes were read with.
      let saved: Base = base, placeFailure: { error: unknown } | null = null;
      if (sent.cwd !== was.cwd) {
        const writing = placeIntent.submit(() => ({ task: project.id, cwd: sent.cwd || null, expectedTaskHash: base.hash }), send);
        if (writing === undefined) return false;
        try {
          const task = await writing;
          if (!answer.sameDraft()) return;
          saved = { hash: task.hash, draft: { ...saved.draft, cwd: sent.cwd } };
        } catch (error) {
          if (!answer.sameDraft()) return;
          placeFailure = { error };
        }
      }
      if (schemaChanged(was, sent)) {
        // The fields before the values: a value of a field just added is written against the schema that has it.
        try {
          const written = await saveSchema(client, root, { task: project.id, fields: sent.ownFields ? sent.fields : null, expectedTaskHash: saved.hash }, crypto.randomUUID());
          if (!answer.sameDraft()) return;
          saved = { hash: written.task.hash, draft: { ...saved.draft, fields: sent.fields, ownFields: sent.ownFields } };
        } catch (error) {
          if (!answer.sameDraft()) return;
          keep(saved, valid);
          throw error;
        }
      }
      if (Object.keys(change).length) {
        // After the location's write, the Task is expected as that write answered it (the row it published), not as
        // the detail first read it.
        // After the schema's write the Task's hash moved before the feed shows it: the server checks the hash it answered.
        const placed = saved !== base, reschemed = saved.hash !== base.hash;
        const writing = taskIntent.submit(() => ({ task: project.id, ...change, expectedTaskHash: saved.hash }), placed
          ? (input, opId, basis) => saveProject(client, input, opId, basis ?? (reschemed ? workspaceWriteBasis() : rowWriteBasis(project.id, input.expectedTaskHash))) : send);
        if (writing === undefined) { keep(saved, valid); return false; }
        try {
          const task = await writing;
          if (!answer.sameDraft()) return;
          saved = { hash: task.hash, draft: { ...sent, cwd: saved.draft.cwd, fields: saved.draft.fields, ownFields: saved.draft.ownFields } };
        } catch (error) {
          if (!answer.sameDraft()) return;
          keep(saved, valid);
          throw error;
        }
      }
      if (placeFailure) {
        // What the Task took stays saved; the location says why it was not.
        keep(saved, valid);
        form.setError("cwd", { type: "server", message: t("project.locationNotSaved") });
        if (retryOf(placeFailure.error) !== "fix") throw placeFailure.error;
        return false;
      }
      setBase(saved);
      form.reset(saved.draft);
    },
  });
  const capture = useAnswerGuard(form);
  /** A part saved and a part not: the saved part is the base now, and the rest stays as typed. */
  const keep = (saved: Base, typed: ProjectDraft) => { setBase(saved); form.reset(saved.draft); form.reset(typed, { keepDefaultValues: true }); };
  // The draft starts from a read of the project's Task made for this opening (its title, colour, values and hash
  // together), not one kept from before (a reload keeps the views read earlier), and its code location as the index
  // has it; later reads do not move it.
  const [read, setRead] = useState(false);
  useEffect(() => {
    let live = true;
    void query.refetch().then(() => { if (live) setRead(true); });
    return () => { live = false; };
    // Once, as the settings open: the reread after a refusal reads again itself.
  }, []);
  useEffect(() => {
    const schema = tasksSchema.data;
    if (base !== null || !read || query.isFetching || !detail?.settings || !schema || tasksSchema.isFetching) return;
    const start: ProjectDraft = { title: detail.title, color: detail.settings.color, cwd: project.cwd ?? "",
      fields: [...schema.fields], ownFields: schema.from === project.id,
      policy: typeof detail.values.values[PROJECT_POLICY] === "string" ? detail.values.values[PROJECT_POLICY] as string : "" };
    form.reset(start);
    setBase({ hash: detail.hash, draft: start });
  }, [base, read, query.isFetching, detail, tasksSchema.data, tasksSchema.isFetching, project.cwd, form]);

  /**
   * Load the latest. A save whose answer was lost is sent again first, as the same operation, and what it answers is
   * folded into the base; what was not sent stays as typed. A refusal (of the save, or of the resent one: changed
   * elsewhere) starts the draft again from the latest read. A restore refusal keeps the record and typed draft.
   */
  const reread = async () => {
    if (base === null) return;
    const answer = capture(), typed = form.getValues();
    const lost = intents.some(({ status }) => status === "unconfirmed");
    // What resending said: confirmed (folded in below), still unknown (stay as it is), or refused (read the latest).
    let next = base, refused = false;
    try {
      for (const intent of intents) {
        if (intent.status !== "unconfirmed") continue;
        const sent = intent.payload!, replay = intent.retrySame(send);
        if (replay) { const task = await replay; next = { hash: task.hash, draft: draftAfterResend(next.draft, sent) }; }
      }
    } catch (error) {
      if (form.retainCheckFailure(error)) return;
      refused = true;
    }
    if (!answer.sameOpening()) return;
    for (const intent of intents) intent.reset();
    form.clearFailure();
    if (lost && !refused) { keep(next, typed); return; }
    // The draft starts again from both reads: the Task and the fields its Tasks use (a refused schema write moved them).
    await Promise.all([query.refetch(), tasksSchema.refetch()]);
    if (!answer.sameOpening()) return;
    setBase(null);
  };
  return { form, base, task, query, tasksSchema, busy, writeDisabled, reread,
    unproven: intents.some(intent => intent.unproven), unconfirmed: intents.some(({ status }) => status === "unconfirmed"), blocked: intents.some(({ blocked }) => blocked) };
}
