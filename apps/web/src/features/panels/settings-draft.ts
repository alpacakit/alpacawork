import { detailWriteBasis, type WriteBasis } from "@/data/connection";
import type { QueryClient } from "@tanstack/react-query";
import { stringify } from "yaml";
import { z } from "zod";
import { DEFAULT_FIELDS, PROJECT_POLICY, PROJECT_SUMMARY, hardLimit, projectColorSchema, titleSchema,
  type ServerSettings, type ValuesPatch } from "@alpacawork/contract";
import { readServerAgents, serverAgentDraftSchema } from './server-agent-draft';
import { newStackRow, readStack, writeStack } from './ai-stack-draft';
import { taskWriteResultSchema, type ControlTaskHeadDTO } from "@alpacawork/contract/control";
import { writeTask } from "@/data/task-write";
import { markRead } from "@/state/read-store";

/** The Server tab owns limits, Jev, typed agents and the AI stacks; config/set receives one derived agents: block. */
export type ServerDraft = z.infer<typeof serverAgentDraftSchema>;

export function serverDraft(settings: ServerSettings): ServerDraft {
  const agents = readServerAgents(settings.agentsText);
  // With no saved tasks' stack, the editor starts it as its own "Add" does: the first enabled agent on its start values.
  const added = settings.aiStack === undefined && agents.ok ? newStackRow(agents.value.agents, []) : null;
  // The input's stack is shown as saved: none saved is none set, which the input says until one is added here.
  return { limits: { ...settings.limits }, /* jev: { ...settings.jev }, */ agents,
    aiStack: added ? [added] : readStack(settings.aiStack), coordinatorAiStack: readStack(settings.coordinatorAiStack) };
}
/**
 * The limits, the AI stacks and Jev config/set writes beside the agents block; the YAML example shows the same text.
 * Jev always goes with them, so an emptied endpoint reaches the server and turns Jev off. A stack absent leaves it in
 * config.yaml as it is; given, it is written, an empty one too (setup going on with no agent clears it).
 */
export function configYaml(draft: Pick<ServerDraft, 'limits' | 'agents'> & Partial<Pick<ServerDraft, 'aiStack' | 'coordinatorAiStack'>>) {
  const agents = draft.agents.ok ? draft.agents.value.agents : [];
  return stringify({ limits: draft.limits, ...draft.aiStack ? { aiStack: writeStack(draft.aiStack, agents) } : {},
    ...draft.coordinatorAiStack ? { coordinatorAiStack: writeStack(draft.coordinatorAiStack, agents) } : {}, /* jev: draft.jev */ },
    { lineWidth: 0, aliasDuplicateObjects: false });
}
/** The most a project's summary may hold: what the server takes for its field (about 30% over the size aimed for). */
export const PROJECT_SUMMARY_LIMIT = hardLimit(DEFAULT_FIELDS.find(({ id }) => id === PROJECT_SUMMARY)!.maxChars!);
/** The project's own values the settings edit, by the draft key holding each as typed ("" for none). */
const PROJECT_VALUES = { summary: PROJECT_SUMMARY, policy: PROJECT_POLICY } as const;
type ProjectValueKey = keyof typeof PROJECT_VALUES;
const projectValueKeys = Object.keys(PROJECT_VALUES) as ProjectValueKey[];
/** Counted as the server counts the field's length, so the form refuses what a save would be refused for. */
const summarySchema = z.string().superRefine((value, context) => {
  if (value.length > PROJECT_SUMMARY_LIMIT)
    context.addIssue({ code: "custom", message: `At most ${PROJECT_SUMMARY_LIMIT} characters`, params: { kind: "too_long", maximum: PROJECT_SUMMARY_LIMIT } });
});
/**
 * A project's settings as one draft: its Task's title and colour, its code location on this PC, the fields its Tasks
 * use in order (`ownFields` false: inherited from above, as `fields` shows them) and its own values (summary, policy) as typed.
 */
export const projectDraftSchema = z.object({ title: titleSchema, color: projectColorSchema, cwd: z.string(),
  fields: z.array(z.string()), ownFields: z.boolean(), summary: summarySchema, policy: z.string() });
export type ProjectDraft = z.infer<typeof projectDraftSchema>;
/** The project's own values as a draft holds them, from the values its Task was read with. */
export function draftValues(values: Readonly<Record<string, unknown>>): Pick<ProjectDraft, ProjectValueKey> {
  return Object.fromEntries(projectValueKeys.map((key) => {
    const value = values[PROJECT_VALUES[key]];
    return [key, typeof value === "string" ? value : ""];
  })) as Pick<ProjectDraft, ProjectValueKey>;
}
/**
 * What a project's settings change on its Task, against the hash they were read with: its title, colour and own values
 * (null clearing one); in this PC's config.yaml, its code location (`null` inherits it).
 */
export type ProjectUpdate = { task: string; title?: string; color?: string; values?: ValuesPatch; cwd?: string | null; expectedTaskHash: string };
/** What a save writes on the Task: each key only when it changed; a value emptied is cleared. */
export function projectChange(was: ProjectDraft, sent: ProjectDraft): Pick<ProjectUpdate, "title" | "color" | "values"> {
  const values: ValuesPatch = Object.fromEntries(projectValueKeys.filter((key) => sent[key] !== was[key])
    .map((key) => [PROJECT_VALUES[key], sent[key].trim() ? sent[key] : null]));
  return { ...sent.title === was.title ? {} : { title: sent.title }, ...sent.color === was.color ? {} : { color: sent.color },
    ...Object.keys(values).length ? { values } : {} };
}
/** Whether a save changes the project's own fields: their order or membership, or whether it inherits them. */
export const schemaChanged = (was: ProjectDraft, sent: ProjectDraft) =>
  was.ownFields !== sent.ownFields || sent.ownFields && JSON.stringify(was.fields) !== JSON.stringify(sent.fields);
/** The draft once a save sent again is answered: what that save carried, the rest as it was. */
export function draftAfterResend(draft: ProjectDraft, { title, color, values, cwd }: ProjectUpdate): ProjectDraft {
  const sentValues = projectValueKeys.filter((key) => values && PROJECT_VALUES[key] in values)
    .map((key) => [key, draftValues(values!)[key]]);
  return { ...draft, ...title === undefined ? {} : { title }, ...color === undefined ? {} : { color },
    ...Object.fromEntries(sentValues),
    ...cwd === undefined ? {} : { cwd: cwd ?? "" } };
}
/** Saves `input` on the project's Task and answers the Task as written, so the next save expects its new hash. */
export async function saveProject(client: QueryClient, input: ProjectUpdate, opId: string, basis?: WriteBasis): Promise<ControlTaskHeadDTO> {
  const { task, local } = await writeTask(client, "task/update", input, taskWriteResultSchema, opId, basis ?? detailWriteBasis(input.task, input.expectedTaskHash));
  // The writer has seen what they wrote; their own save is not news to them.
  if (local === 'applied') markRead(task.id);
  return task;
}


