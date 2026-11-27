/**
 * The server's environment file on the settings screen: where a key has to be written is named by its path, a restart
 * is asked for, and what the file did not do is said by line number, in both languages.
 */
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render as bareRender, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { adapterCatalog, DEFAULT_LIMITS, type EnvironmentFile } from "@alpacawork/contract";
import { AgentSettings } from "../src/features/panels/AgentSettings";
import { newAgentDraft } from "../src/features/panels/agent-settings-draft";
import { SettingsBody } from "../src/features/panels/SettingsDialog";
import { queryClient } from "../src/data/query-client";
import { screenData, TestWorkspace, WithQueries } from "./fixtures";

// Drawn as the screen draws it, inside the queries' provider: an agent's mark reads the server settings.
const render = (ui: Parameters<typeof bareRender>[0]) => bareRender(ui, { wrapper: WithQueries });

const PATH = "/home/person/.config/alpacawork/env";
beforeAll(() => { startI18n(); });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

/** The server settings tab over a server that read its environment file as `file`. */
async function openServer(file: EnvironmentFile, language: "en" | "ja") {
  await i18n.changeLanguage(language);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
    const answer = (value: unknown) => new Response(JSON.stringify(value));
    if (String(url).includes("/api/environment-file")) return answer(file);
    if (String(url).includes("/api/commands/config/get")) return answer({ hash: "c".repeat(64), limits: { ...DEFAULT_LIMITS }, agentsText: "agents: {}\n", agents: {}, catalog: adapterCatalog() });
    if (String(url).includes("/api/update/status")) return answer({ kind: "none" });
    if (String(url).includes("/api/telemetry/status")) return answer({ state: "blocked", blockedBy: "test", digest: null });
    throw new Error(`Unexpected settings request: ${String(url)}`);
  });
  render(<TestWorkspace data={screenData()}><SettingsBody initialTab="ai" /></TestWorkspace>);
  await waitFor(() => expect(document.querySelector("[data-environment-file]")).toBeTruthy());
  return { line: document.querySelector<HTMLElement>("[data-environment-file]")!, problems: document.querySelector<HTMLElement>("[data-environment-file-problems]") };
}

test.each([
  ["en", "No file", "3 variables set"],
  ["ja", "ファイルなし", "3 件を反映中"],
] as const)("the tab names the file and says what it did, with no caution while all of it is applied (%s)", async (language, absent, applied) => {
  let view = await openServer({ path: PATH, state: "absent", applied: 0, skipped: [] }, language);
  expect(view.line.querySelector("[data-environment-file-path]")!.textContent).toBe(PATH);
  expect(view.line.querySelector("[data-environment-file-state]")!.textContent).toBe(absent);
  expect(view.problems).toBeNull();
  cleanup(); queryClient.clear(); vi.restoreAllMocks();
  view = await openServer({ path: PATH, state: "read", applied: 3, skipped: [] }, language);
  expect(view.line.querySelector("[data-environment-file-state]")!.textContent).toBe(applied);
  expect(view.problems).toBeNull();
});

test.each([
  ["en", "Some lines of the environment file were not applied", ["Line 2: it is not in the form NAME=value", "Line 5: alpacawork sets this name itself, so it cannot be set here",
    "Line 7: the same name is on an earlier line, and the earlier line is used"], `Fix ${PATH} on the server's PC, then restart the server.`],
  ["ja", "環境変数ファイルに反映していない行があります", ["2 行目: 名前=値 の形ではありません", "5 行目: alpacawork が決める名前なので、ここでは設定できません",
    "7 行目: 同じ名前が前の行にあります。前の行を使っています"], `サーバーの PC の ${PATH} を直し、サーバーを再起動してください。`],
] as const)("lines that set nothing are told by number and reason (%s)", async (language, title, reasons, fix) => {
  const view = await openServer({ path: PATH, state: "read", applied: 1,
    skipped: [{ line: 2, reason: "malformed" }, { line: 5, reason: "reserved" }, { line: 7, reason: "duplicate" }] }, language);
  expect(view.problems!.textContent).toContain(title);
  for (const reason of reasons) expect(view.problems!.textContent).toContain(reason);
  expect(view.problems!.textContent).toContain(fix);
});

test.each([
  ["en", { permissions: /Other users can read or write it\. Run chmod 600/, owner: /belongs to a different user/, not_regular_file: /not a regular file/, unreadable: /could not be read/ },
    "The environment file was not read", "Not read"],
  ["ja", { permissions: /ほかのユーザーが読み書きできます。chmod 600/, owner: /サーバーを動かしているユーザーのファイルではありません/, not_regular_file: /通常のファイルではありません/, unreadable: /読めませんでした/ },
    "環境変数ファイルを読み込んでいません", "読み込んでいません"],
] as const)("a file left unread says why (%s)", async (language, reasons, title, state) => {
  for (const [reason, text] of Object.entries(reasons) as [keyof typeof reasons, RegExp][]) {
    const view = await openServer({ path: PATH, state: reason, applied: 0, skipped: [] }, language);
    expect(view.problems!.textContent).toContain(title);
    expect(view.problems!.textContent).toMatch(text);
    expect(view.problems!.textContent).toContain(PATH);
    expect(view.line.querySelector("[data-environment-file-state]")!.textContent).toBe(state);
    cleanup(); queryClient.clear(); vi.restoreAllMocks();
  }
});

test.each([
  ["en", "+ Add agent", `Authentication required. On the server's PC, run claude auth login, or add the line ANTHROPIC_API_KEY=your-key to ${PATH} on the server's PC and restart the server`,
    "Authentication required. On the server's PC, run claude auth login", "Expand codex", `Names (comma-separated). Set their values in ${PATH} on the server's PC, then restart the server`],
  ["ja", "＋ エージェントを追加", `認証が必要です。サーバーの PC で claude auth login を実行するか、サーバーの PC の ${PATH} に ANTHROPIC_API_KEY=キー の行を書いて、サーバーを再起動してください`,
    "認証が必要です。サーバーの PC で claude auth login を実行してください", "codex を開く", `名前（カンマ区切り）。値はサーバーの PC の ${PATH} に書き、サーバーを再起動します`],
] as const)("where an agent's key is asked for, the file is named and a restart asked for (%s)", async (language, add, withFile, withoutFile, expand, hint) => {
  await i18n.changeLanguage(language);
  // With codex there already, the kind offered first when adding is claude, whose other way in is a key.
  const draft = { source: "{}", agents: [newAgentDraft("codex", "codex", "codex")] };
  const view = render(<AgentSettings draft={draft} onChange={() => {}} environmentFile={PATH} />);
  fireEvent.click(screen.getByRole("button", { name: add }));
  // The sign-in command is set in code inside the sentence, so the sentence is read whole.
  const sentence = (text: string) => screen.getByText((_, element) => element?.tagName === "P" && element.textContent === text);
  expect(sentence(withFile)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: expand }));
  expect(screen.getByText(hint)).toBeTruthy();
  // Until the server has said where its file is, only the sign-in is asked for: no place is guessed.
  view.unmount();
  render(<AgentSettings draft={draft} onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: add }));
  expect(sentence(withoutFile)).toBeTruthy();
});
