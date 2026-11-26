import { commandRoute } from '@alpacawork/contract/command-path';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fieldCatalog, fieldListResultSchema, fieldSetResultSchema, fieldGetResultSchema, fieldUseResultSchema, type FieldCatalog, type FieldDef } from "@alpacawork/contract";
import { z } from "zod";
import { api } from "./resources";
import { workspaceWriteBasis } from "./connection";
import { useWorkspaceInfo } from "./queries";

/** One field as `field list` answers it: its definition and what it is to the app and the workspace. */
export type FieldView = z.infer<typeof fieldListResultSchema>["fields"][number];
const definition = ({ id, title, type, many, maxChars, maxItems, hint, members, required, direction }: FieldView): FieldDef =>
  ({ id, title, type, many, maxChars, maxItems, hint, members, required, direction });

const SHIPPED = fieldCatalog([]);
const fieldsKey = (root: string) => ["fields", root] as const;
const schemaKey = (root: string, task: string) => ["schema", root, task] as const;

/**
 * The workspace's field definitions (`field list`): the views to list and the catalog the values' zod and render read
 * (the same definitions the server checks with), the app's defaults until they are read. Read again when this page
 * saves a definition or a schema.
 */
export function useFieldCatalog(enabled = true) {
  const root = useWorkspaceInfo(info => info.root);
  const query = useQuery({ queryKey: fieldsKey(root), enabled: !!root && enabled, staleTime: 30_000,
    queryFn: ({ signal }) => api.request(commandRoute("field/list"), fieldListResultSchema, signal) });
  const fields = query.data?.fields;
  // Until the workspace's definitions are read, the app's own defaults stand for them (the server checks every write).
  const catalog: FieldCatalog = fields ? new Map(fields.map(view => [view.id, definition(view)])) : SHIPPED;
  return { query, fields, catalog };
}

/** The fields a Task or project uses (`field get`) and the project they come from (null: the shipped default); null reads nothing. */
export function useTaskSchema(task: string | null) {
  const root = useWorkspaceInfo(info => info.root);
  return useQuery({ queryKey: schemaKey(root, task ?? ""), enabled: !!root && task !== null, staleTime: 0,
    queryFn: ({ signal }) => api.request(`${commandRoute('field/get')}?task=${encodeURIComponent(task!)}`, fieldGetResultSchema, signal) });
}

/** What `field set` takes: the field's ID and the keys it changes (a new field names title and type). */
export type FieldSet = { field: string } & Partial<Omit<FieldDef, "id">>;
/** Adds a definition or changes one, for every project that uses it; the field list and schemas are read again. */
export function useSaveField() {
  const client = useQueryClient();
  const root = useWorkspaceInfo(info => info.root);
  // The definition's editor says a refusal beside the field it is about; no toast says it again.
  return useMutation({ meta: { errorToast: false }, mutationFn: async (input: FieldSet) => {
    const answer = await api.request(commandRoute("field/set"), fieldSetResultSchema, undefined, input, crypto.randomUUID(), workspaceWriteBasis());
    await client.invalidateQueries({ queryKey: fieldsKey(root) });
    return answer.field;
  } });
}

/** Writes a project's own fields in order, or with null makes it inherit them; answers the project Task's new head. */
export async function saveSchema(client: ReturnType<typeof useQueryClient>, root: string,
  input: { task: string; fields: string[] | null; expectedTaskHash: string }, opId: string) {
  const answer = await api.request(commandRoute("field/use"), fieldUseResultSchema, undefined,
    { task: input.task, ...input.fields ? { fields: input.fields } : { inherit: true }, expectedTaskHash: input.expectedTaskHash },
    opId, workspaceWriteBasis());
  await Promise.all([client.invalidateQueries({ queryKey: ["schema", root] }), client.invalidateQueries({ queryKey: fieldsKey(root) })]);
  return answer;
}
