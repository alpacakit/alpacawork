import { detailWriteBasis, type WriteBasis } from "@/data/connection";
import type { QueryClient } from "@tanstack/react-query";
import { stringify } from "yaml";
import { z } from "zod";
import { PROJECT_POLICY, projectColorSchema, titleSchema, type ServerSettings, type ValuesPatch } from "@alpacawork/contract";
import { readServerAgents, serverAgentDraftSchema } from './server-agent-draft';
import { readStack, writeStack } from './ai-stack-draft';
import { taskWriteResultSchema, type ControlTaskHeadDTO } from "@alpacawork/contract/control";
import { writeTask } from "@/data/task-write";
import { markRead } from "@/state/read-store";

/** The Server tab owns limits, Jev, typed agents and the AI stack; config/set receives one derived agents: block. */
export type ServerDraft = z.infer<typeof serverAgentDraftSchema>;

export function serverDraft(settings: ServerSettings): ServerDraft {
  return { limits: { ...settings.limits }, /* jev: { ...settings.jev }, */ agents: readServerAgents(settings.agentsText),
    aiStack: readStack(settings.aiStack) };
}
/**
 * The limits, the AI stack and Jev config/set writes beside the agents block; the YAML example shows the same text.
 * Jev always goes with them, so an emptied endpoint reaches the server and turns Jev off. `aiStack` absent leaves the
 * stack in config.yaml as it is; given, it is written, an empty one too (setup going on with no agent clears it).
 */
export function configYaml(draft: Pick<ServerDraft, 'limits'> & Partial<Pick<ServerDraft, 'aiStack'>>) {
  return stringify({ limits: draft.limits, ...draft.aiStack ? { aiStack: writeStack(draft.aiStack) } : {}, /* jev: draft.jev */ },
    { lineWidth: 0, aliasDuplicateObjects: false });
}
/**
 * A project's settings as one draft: its Task's title and colour, its code location on this PC, the fields its Tasks
 * use in order (`ownFields` false: inherited from above, as `fields` shows them) and its policy text as typed.
 */
export const projectDraftSchema = z.object({ title: titleSchema, color: projectColorSchema, cwd: z.string(),
  fields: z.array(z.string()), ownFields: z.boolean(), policy: z.string() });
export type ProjectDraft = z.infer<typeof projectDraftSchema>;
/**
 * What a project's settings change on its Task, against the hash they were read with: its title, colour and policy
 * (a value of the policy field, null clearing it); in this PC's config.yaml, its code location (`null` inherits it).
 */
export type ProjectUpdate = { task: string; title?: string; color?: string; values?: ValuesPatch; cwd?: string | null; expectedTaskHash: string };
/** What a save writes on the Task: each key only when it changed. */
export function projectChange(was: ProjectDraft, sent: ProjectDraft): Pick<ProjectUpdate, "title" | "color" | "values"> {
  return { ...sent.title === was.title ? {} : { title: sent.title }, ...sent.color === was.color ? {} : { color: sent.color },
    ...sent.policy === was.policy ? {} : { values: { [PROJECT_POLICY]: sent.policy.trim() ? sent.policy : null } } };
}
/** Whether a save changes the project's own fields: their order or membership, or whether it inherits them. */
export const schemaChanged = (was: ProjectDraft, sent: ProjectDraft) =>
  was.ownFields !== sent.ownFields || sent.ownFields && JSON.stringify(was.fields) !== JSON.stringify(sent.fields);
/** The draft once a save sent again is answered: what that save carried, the rest as it was. */
export function draftAfterResend(draft: ProjectDraft, { title, color, values, cwd }: ProjectUpdate): ProjectDraft {
  const policy = values?.[PROJECT_POLICY];
  return { ...draft, ...title === undefined ? {} : { title }, ...color === undefined ? {} : { color },
    ...values ? { policy: typeof policy === "string" ? policy : "" } : {},
    ...cwd === undefined ? {} : { cwd: cwd ?? "" } };
}
/** Saves `input` on the project's Task and answers the Task as written, so the next save expects its new hash. */
export async function saveProject(client: QueryClient, input: ProjectUpdate, opId: string, basis?: WriteBasis): Promise<ControlTaskHeadDTO> {
  const { task, local } = await writeTask(client, "task/update", input, taskWriteResultSchema, opId, basis ?? detailWriteBasis(input.task, input.expectedTaskHash));
  // The writer has seen what they wrote; their own save is not news to them.
  if (local === 'applied') markRead(task.id);
  return task;
}


