import { problemResponse } from './problem';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import { indexOf } from './fixtures';
import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { parse } from "yaml";
import { adapterCatalog, checkAgentsText, DEFAULT_LIMITS } from "@alpacawork/contract";
import type { ControlTaskDTO } from "@alpacawork/contract/control";
import { SettingsDialog } from "../src/features/panels/SettingsDialog";
import { Toaster } from "../src/components/ui/toaster";
import { intentKey, useWriteIntentStore } from "../src/data/write-intent";
import { TestWorkspace, dto, project, screenData, tree, viewsOf, PROJECT_TASK } from "./fixtures";
import { setupForms, errorToasts, refusal, answer, written } from "./forms-fixture";

setupForms();

/**
 * Server settings: this PC's config.yaml read when the dialog opens and saved through config/set. A project's own
 * settings are the project dialog's (project-settings.test.tsx).
 */
const OPEN = "c".repeat(64), LATEST = "d".repeat(64), SAVED_1 = "1".repeat(64), SAVED_2 = "2".repeat(64);

const AGENTS = `agents:
  # hand-written note
  claude:
    params:
      model: [opus, sonnet]
      effort: [high, low]
`;

/** The fixture's project Task with this goal (its body) at this hash. */
const goal = (body: string, hash: string): ControlTaskDTO => project({ body, hash });
/** The project's view as `task/view` answers it. */
const goalView = (body: string, hash: string) => viewsOf(tree({ tasks: [dto(), goal(body, hash)] })).find((view) => view.task.id === PROJECT_TASK);
const serverSettings = (hash = OPEN) => ({ hash, agentsText: AGENTS, agents: checkAgentsText(AGENTS).agents!, catalog: adapterCatalog(), limits: { ...DEFAULT_LIMITS },
  aiStack: [{ agent: 'claude', values: { model: 'opus', effort: 'high' } }], coordinatorAiStack: [{ agent: 'claude', values: { model: 'opus', effort: 'low' } }] });

function serverFetch(saves: (Response | Error)[], reads: unknown[] = [serverSettings()]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
    const next = <T,>(list: T[]) => (list.length > 1 ? list.shift() : list[0]) as T;
    if (String(url).includes("/api/config/get")) return answer(next(reads));
    if (String(url).includes("/api/task/view")) return answer(goalView("# Goal\n", OPEN));
    // Settings read the update status; it is no save.
    if (String(url).includes("/api/update/status")) return answer({ kind: "none" });
    if (String(url).includes("/api/telemetry/status")) return answer({ state: "blocked", blockedBy: "test", digest: null });
    if (String(url).includes("/api/environment-file")) return answer({ path: "/fixture-home/.config/alpacawork/env", state: "absent", applied: 0, skipped: [] });
    if (!String(url).includes("/api/config/set")) throw new Error(`Unexpected settings request: ${String(url)}`);
    const value = next(saves);
    if (value instanceof Error) throw value;
    return value.clone();
  });
}

const saveCalls = (fetcher: ReturnType<typeof vi.spyOn>) =>
  fetcher.mock.calls.filter(([url]: unknown[]) => String(url).includes("/api/config/set"));

const saveBody = (fetcher: ReturnType<typeof vi.spyOn>, index = 0) => JSON.parse(String((saveCalls(fetcher)[index]?.[1] as RequestInit).body));

/** The project's own saves (its title, goal or extracts) through task update. */
const updateCalls = (fetcher: ReturnType<typeof vi.spyOn>) =>
  fetcher.mock.calls.filter(([url]: unknown[]) => String(url).includes("/api/task/update"));

const updateBody = (fetcher: ReturnType<typeof vi.spyOn>, index = 0) => JSON.parse(String((updateCalls(fetcher)[index]?.[1] as RequestInit).body));

/** The tab's save, in its foot. */
const save = () => within(document.querySelector<HTMLElement>("[data-settings-foot]")!).getByRole("button", { name: "Save" }) as HTMLButtonElement;

/** The screen with the fixture's project holding this goal at the `OPEN` hash. */
const openServer = async () => {
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), goal("# Goal\n", OPEN)] }))}><SettingsDialog initialTab="server" /><Toaster /></TestWorkspace>);
  await waitFor(() => expect(document.getElementById("server-advanced")).toBeTruthy());
  // The agents fold and its cards open closed; the tests edit claude's values where there is a claude.
  agentsFold().open = true;
  const expand = screen.queryByRole("button", { name: "Expand claude" });
  if (expand) fireEvent.click(expand);
};

const parallel = () => screen.getByLabelText("Max concurrent runs") as HTMLInputElement;

const advanced = () => document.getElementById("server-advanced") as HTMLDetailsElement;
const agentsFold = () => document.getElementById("server-agents") as HTMLDetailsElement;

const agentsField = () => screen.getByRole("textbox", { name: "Available values for model" }) as HTMLTextAreaElement;

test("a server save sends edited agent values with comments and limits, and the next save uses the returned hash", async () => {
  const fetcher = serverFetch([answer(serverSettings(SAVED_1)), answer(serverSettings(SAVED_2))]);
  await openServer();
  expect(advanced().open).toBe(false);
  expect(agentsField().value).toBe("opus, sonnet");
  expect(save().disabled).toBe(true);
  fireEvent.change(agentsField(), { target: { value: 'temporary-model' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(agentsField().value).toBe('opus, sonnet');
  expect(save().disabled).toBe(true);
  const typed = "opus, sonnet, new-model";
  fireEvent.change(parallel(), { target: { value: "4" } });
  fireEvent.change(agentsField(), { target: { value: typed } });
  fireEvent.click(save());
  await waitFor(() => expect(document.querySelector("[data-settings-foot] [role=status]")?.textContent).toBe("Saved"));
  const first = saveBody(fetcher);
  expect(first.expectedConfigHash).toBe(OPEN);
  expect(parse(first.agents).agents.claude.params.model).toEqual(["opus", "sonnet", "new-model"]);
  expect(first.agents).toContain("# hand-written note");
  expect(parse(first.config)).toMatchObject({ limits: { parallel: 4 } });
  expect(parse(first.config).agents).toBeUndefined();
  expect(updateCalls(fetcher)).toHaveLength(0);
  fireEvent.change(parallel(), { target: { value: "5" } });
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(2));
  expect(saveBody(fetcher, 1).expectedConfigHash).toBe(SAVED_1);
});

test("invalid agent values in a collapsed card block saving, open and focus the row, and can be corrected there", async () => {
  const fetcher = serverFetch([answer(serverSettings(SAVED_1))]);
  await openServer();
  fireEvent.change(agentsField(), { target: { value: 'opus,,sonnet' } });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse claude' }));
  // Closed, and its toggle delivered, before the save, as a person's close would be.
  const closed = new Promise(resolve => agentsFold().addEventListener('toggle', resolve, { once: true }));
  agentsFold().open = false;
  await closed;
  fireEvent.click(save());
  await waitFor(() => expect(agentsFold().open).toBe(true));
  await waitFor(() => expect(document.activeElement).toBe(agentsField()));
  expect(agentsField().getAttribute('aria-invalid')).toBe('true');
  expect(saveCalls(fetcher)).toHaveLength(0);
  fireEvent.change(agentsField(), { target: { value: 'sonnet, opus' } });
  await waitFor(() => expect(agentsField().getAttribute('aria-invalid')).toBe('false'));
  fireEvent.click(save());
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(1));
  expect(parse(saveBody(fetcher).agents).agents.claude.params.model).toEqual(['sonnet', 'opus']);
});

test("a save the AI stack refuses says why by the button and takes the eye to the row to fix", async () => {
  const fetcher = serverFetch([answer(serverSettings(SAVED_1))], [{ ...serverSettings(),
    aiStack: [{ agent: 'claude', values: { model: 'opus', effort: 'high' } }, { agent: 'gone', values: {} }] }]);
  await openServer();
  fireEvent.change(parallel(), { target: { value: "3" } });
  fireEvent.click(save());
  await waitFor(() => expect(document.querySelector('[data-ai-stack-refused]')).not.toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Agent in row 2')));
  expect(saveCalls(fetcher)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Remove row 2' }));
  await waitFor(() => expect(document.querySelector('[data-ai-stack-refused]')).toBeNull());
  fireEvent.click(save());
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(1));
});

test("a broken YAML read and a limit below its minimum block saving without dropping the source", async () => {
  const fetcher = serverFetch([answer(serverSettings())], [{ ...serverSettings(), agentsText: 'agents:\n  codex: *missing\n' }]);
  await openServer();
  fireEvent.change(parallel(), { target: { value: '0' } });
  fireEvent.click(save());
  expect(await screen.findByText('Use a whole number of at least 1')).toBeTruthy();
  expect(screen.getByText('Cannot read agents in config.yaml. Fix the file, then choose “Load the latest”.')).toBeTruthy();
  expect(saveCalls(fetcher)).toHaveLength(0);
});

test("a server 409 saves nothing, blocks the save, and loading the latest shows the hand edit with its hash", async () => {
  const fetcher = serverFetch([refusal(409), answer(serverSettings(SAVED_1))],
    [serverSettings(), { ...serverSettings(LATEST), limits: { ...serverSettings().limits, parallel: 6 } }]);
  await openServer();
  fireEvent.change(parallel(), { target: { value: "3" } });
  fireEvent.click(save());
  await screen.findByText(/Another change conflicts with this one/);
  expect(save().disabled).toBe(true);
  expect(errorToasts()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Load the latest" }));
  await waitFor(() => expect(parallel().value).toBe("6"));
  fireEvent.change(parallel(), { target: { value: "7" } });
  fireEvent.click(save());
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(2));
  expect(saveBody(fetcher, 1).expectedConfigHash).toBe(LATEST);
});

test.each([503, 0] as const)("a server save with an unconfirmed answer (%s) keeps its draft and cannot resend until reopened", async (status) => {
  const fetcher = serverFetch([status ? refusal(status) : new TypeError("No answer")]);
  await openServer();
  fireEvent.change(parallel(), { target: { value: "3" } });
  fireEvent.click(save());
  await screen.findByText(/Check whether the change was saved/);
  expect(useWriteIntentStore.getState().entries[intentKey("/fixture", "server-settings", null)]?.status).toBe("unconfirmed");
  expect(save().disabled).toBe(true);
  expect(parallel().value).toBe("3");
  fireEvent.click(save());
  expect(saveCalls(fetcher)).toHaveLength(1);
  expect(errorToasts()).toEqual([]);
});

test("other server refusals appear in the form and can resend", async () => {
  const fetcher = serverFetch([refusal(400), answer(serverSettings(SAVED_1))]);
  await openServer();
  fireEvent.change(parallel(), { target: { value: "3" } });
  fireEvent.click(save());
  await screen.findByText("Check the input.");
  expect(screen.queryByText(/Server refusal/)).toBeNull();
  expect(errorToasts()).toEqual([]);
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(2));
  expect(parse(saveBody(fetcher, 1).config).limits.parallel).toBe(3);
});

test('attachment limit: default, invalid 501 and save 80 MiB', async () => {
  const fetcher = serverFetch([answer({ ...serverSettings(SAVED_1), limits: { ...DEFAULT_LIMITS, attachment_mib: 80 } })]);
  await openServer();
  advanced().open = true;
  const field = document.getElementById('limit-attachment_mib') as HTMLInputElement;
  expect(field.value).toBe('50');
  fireEvent.change(field, { target: { value: '501' } }); fireEvent.click(save());
  await screen.findByText('Use a whole number from 1 to 500');
  expect(saveCalls(fetcher)).toHaveLength(0);
  fireEvent.change(field, { target: { value: '80' } }); fireEvent.click(save());
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(1));
  expect(parse(saveBody(fetcher).config).limits.attachment_mib).toBe(80);
  await waitFor(() => expect(document.querySelector('[data-settings-foot] [role=status]')?.textContent).toBe('Saved'));
});

test('loading latest after a lost server save preserves an actual restore refusal and the typed draft, then permits a distinct new save', async () => {
  const fetcher = serverFetch([refusal(503), problemResponse('restore_changed'), answer(serverSettings(SAVED_1))]);
  await openServer();
  fireEvent.change(parallel(), { target: { value: '3' } }); fireEvent.click(save());
  const key = intentKey('/fixture', 'server-settings', null);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed'));
  const original = useWriteIntentStore.getState().entries[key]!;
  fireEvent.click(screen.getAllByRole('button', { name: 'Load the latest' })[0]!);
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(2));
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('refused'));
  expect(useWriteIntentStore.getState().entries[key]).toMatchObject({ operationId: original.operationId, payload: original.payload, failure: { code: 'restore_changed' } });
  expect(parallel().value).toBe('3');
  await screen.findByText(/This earlier operation is no longer available after a recovery or update/);
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(saveCalls(fetcher)).toHaveLength(3));
  const calls = saveCalls(fetcher), headers = calls.map((call: unknown[]) => new Headers((call[1] as RequestInit).headers));
  expect(calls[1]![1]?.body).toBe(calls[0]![1]?.body);
  expect([...headers[1]!]).toEqual([...headers[0]!]);
  expect(headers[2]!.get('X-Alpacawork-Op-Id')).not.toBe(original.operationId);
});

test('a server form check refused by storage keeps its input and original attempt and removes both ineffective reread entrances', async () => {
  const fetcher = serverFetch([refusal(503)]);
  await openServer(); fireEvent.change(parallel(), { target: { value: '3' } }); fireEvent.click(save());
  const key = intentKey('/fixture', 'server-settings', null);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed'));
  const original = useWriteIntentStore.getState().entries[key]!;
  const bytes = sessionStorage.getItem('alpacawork-write-intents-v5');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('synthetic full storage'); });
  fireEvent.click(screen.getAllByRole('button', { name: 'Load the latest' })[0]!);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load the latest' })).toBeNull());
  expect(saveCalls(fetcher)).toHaveLength(1); expect(useWriteIntentStore.getState().entries[key]).toBe(original);
  expect(sessionStorage.getItem('alpacawork-write-intents-v5')).toBe(bytes); expect(parallel().value).toBe('3');
});
