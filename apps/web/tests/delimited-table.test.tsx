import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import type { TaskDetail } from "../src/data/types";
import { queryClient } from "../src/data/query-client";
import { DELIMITED_MAX_BYTES, DELIMITED_MAX_CELLS, DELIMITED_MAX_ROWS } from "../src/domain/delimited-file";
import { taskFileUrl } from "../src/data/task-file-url";
import { DelimitedFile } from "../src/features/reader/files/DelimitedFile";
import { TestWorkspace, dto, screenData, tree } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); queryClient.clear(); });

type Body = string | Uint8Array;
/** A Task's file drawn as a table (as the viewer draws it), its bytes served by fetch; the view, to show a new revision. */
function open(name: string, body: Body, { size, revision = "r1" }: { size?: number; revision?: string } = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(bytes.slice()));
  const data = screenData(tree({ tasks: [dto()] }));
  const draw = (rev: string) => {
    const files = [{ name, size: size ?? bytes.byteLength, revision: rev, at: "2026-10-27T00:00:00.000Z" }];
    const task = { ...data.tasks[0]!, body: "", logs: [], files, requestHeads: [], extractRows: {}, reply: undefined } as TaskDetail;
    return <TestWorkspace data={data}><DelimitedFile taskId={task.id} file={files[0]!} url={taskFileUrl(task.id, name, rev)} /></TestWorkspace>;
  };
  const view = render(draw(revision));
  return { fetcher, view, revise: (rev: string) => view.rerender(draw(rev)) };
}

const table = () => screen.findByRole("table");
/** Each drawn row as its number and its cells' text, the header's too. */
const rowsOf = (shown: HTMLElement) => [...shown.querySelectorAll("tr")].map(row => [...row.children].map(cell => cell.textContent));
/** The wrap mark, found by what it is whatever it offers next. */
const wrapMark = () => screen.getByRole("button", { name: /^(Wrap lines|Show lines unwrapped)$/ });
const headerSwitch = () => screen.getByRole("switch", { name: "Header row" });
const status = () => screen.queryAllByRole("status").map(note => note.textContent);

test("a TSV is a table of its records as written: header first, numbers in record order, values never retyped", async () => {
  const { fetcher } = open("data/mapping.tsv", 'id\tnote\tcode\n001\t"one\nthree, ""quoted"""\t0012\n002\t\t-0\n');
  const shown = await table();
  expect(rowsOf(shown)).toEqual([["1", "id", "note", "code"], ["2", "001", 'one\nthree, "quoted"', "0012"], ["3", "002", "", "-0"]]);
  // The header record is the table's head, each of its cells naming a column; the numbers name rows and are left out of a selection.
  expect([...shown.querySelectorAll("thead th[scope=col]")].map(cell => cell.textContent)).toEqual(["id", "note", "code"]);
  expect([...shown.querySelectorAll("tbody th[scope=row]")].every(cell => cell.className.includes("select-none"))).toBe(true);
  // One line over the table says how many records there are; the columns are the table's own head.
  expect(screen.getByText("3 rows")).toBeTruthy();
  expect(screen.getByText("Rows 2–3 of 3")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Original file" }).getAttribute("href")).toContain("mapping.tsv");
  expect(status()).toEqual([]);
  expect(fetcher).toHaveBeenCalledOnce();
});

test("folding and the header are the reader's choices over the same bytes; they read nothing again", async () => {
  const { fetcher } = open("a.csv", "name,note\nx,long words\n");
  const shown = await table();
  const frame = shown.closest("section")!;
  // Folded first: the mark is pressed and offers to keep lines whole, as the diff's does.
  expect([frame.dataset.delimited, wrapMark().getAttribute("aria-pressed"), wrapMark().getAttribute("aria-label")]).toEqual(["wrapped", "true", "Show lines unwrapped"]);
  expect(shown.querySelector("td:not([data-missing])")!.className).toContain("whitespace-pre-wrap");
  fireEvent.click(wrapMark());
  expect([frame.dataset.delimited, wrapMark().getAttribute("aria-pressed"), wrapMark().getAttribute("aria-label")]).toEqual(["whole", "false", "Wrap lines"]);
  expect(shown.querySelector("td:not([data-missing])")!.className).toMatch(/(^| )whitespace-pre( |$)/);
  // The header off: the first record is a row like the others, its number and words as they were.
  expect(headerSwitch().getAttribute("aria-checked")).toBe("true");
  fireEvent.click(headerSwitch());
  expect(shown.querySelector("thead")).toBeNull();
  expect(rowsOf(shown)).toEqual([["1", "name", "note"], ["2", "x", "long words"]]);
  expect(screen.getByText("Rows 1–2 of 2")).toBeTruthy();
  expect(fetcher).toHaveBeenCalledOnce();
});

test("the encoding is the file's, not the reader's: Shift_JIS reads as a table, and bytes no encoding reads say so", async () => {
  // 名前,コード\n山田,007 in Shift_JIS.
  const sjis = new Uint8Array([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x0a, 0x8e, 0x52, 0x93, 0x63, 0x2c, 0x30, 0x30, 0x37, 0x0a]);
  const { fetcher } = open("people.csv", sjis);
  expect(rowsOf(await table())).toEqual([["1", "名前", "コード"], ["2", "山田", "007"]]);
  expect([screen.queryByRole("combobox"), status()]).toEqual([null, []]);
  expect(fetcher).toHaveBeenCalledOnce();
  // Neither UTF-8 nor Shift_JIS: one plain reason and the original, with no table and nothing to choose over one (the
  // original is the reason's link, so no head either).
  cleanup(); queryClient.clear(); vi.restoreAllMocks();
  open("broken.csv", new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0x81]));
  expect(await screen.findByText(/character encoding could not be recognized/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Original file" })).toBeTruthy();
  expect([screen.queryByRole("table"), screen.queryByRole("combobox"), screen.queryByRole("switch")])
    .toEqual([null, null, null]);
});

test("records of uneven width keep every cell; a cell a record lacks is hatched, unlike an empty one", async () => {
  open("uneven.csv", "a,b,c\n1,,\n2\n3,4,5,6\n");
  const shown = await table();
  expect(status()).toEqual([expect.stringContaining("different numbers of columns")]);
  const cells = [...shown.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("td")].map(cell => cell.hasAttribute("data-missing") ? "∅" : cell.textContent));
  expect(cells).toEqual([["1", "", "", "∅"], ["2", "∅", "∅", "∅"], ["3", "4", "5", "6"]]);
  expect(shown.querySelectorAll("thead th[scope=col], thead [data-missing]").length).toBe(4);
});

test("an unclosed quote is reported above the table, which still shows what was read", async () => {
  open("bad.csv", 'a,b\n1,"never closed\n2,3\n');
  await table();
  expect(status()).toContainEqual(expect.stringContaining("could not be split into cells"));
});

test("an empty file says so; a header alone says it is all there is", async () => {
  open("empty.csv", "");
  expect(await screen.findByText("This file is empty.")).toBeTruthy();
  expect([screen.queryByRole("table"), screen.queryByRole("switch")]).toEqual([null, null]);
  cleanup(); queryClient.clear(); vi.restoreAllMocks();
  open("head.csv", "a,b\n");
  await table();
  expect(screen.getByText("Only the header row")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Next|Previous/ })).toBeNull();
});

test("records past the table's limit are not dropped silently, and a first record over it is never called empty", async () => {
  open("long.csv", Array.from({ length: DELIMITED_MAX_ROWS + 5 }, (_, i) => String(i)).join("\n"));
  await table();
  expect(status()).toEqual([expect.stringContaining(`Only the first ${DELIMITED_MAX_ROWS} rows are shown`)]);
  cleanup(); queryClient.clear(); vi.restoreAllMocks();
  open("wide.csv", Array.from({ length: DELIMITED_MAX_CELLS + 1 }, () => "x").join(","));
  expect(await screen.findByText(/The first row alone is over a table's limit/)).toBeTruthy();
  expect(screen.queryByText("This file is empty.")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

test("pages hold 100 records each, the header on every page; a choice that leaves fewer pages keeps the page in range", async () => {
  // 201 records: with the header, 200 to page (2 pages); without it, 201 (3 pages).
  open("pages.csv", ["h", ...Array.from({ length: 200 }, (_, i) => `v${i + 2}`)].join("\n") + "\n");
  let shown = await table();
  const numbers = () => [...shown.querySelectorAll("tbody th[scope=row]")].map(cell => Number(cell.textContent));
  expect([numbers().length, numbers()[0], numbers().at(-1), screen.getByText("Rows 2–101 of 201") !== null]).toEqual([100, 2, 101, true]);
  const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Next 100 rows" }));
  shown = await table();
  expect([numbers()[0], numbers().at(-1), rowsOf(shown)[0]]).toEqual([102, 201, ["1", "h"]]);
  // A new page starts at its top: the table is brought into view.
  expect(scrolled).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /^Next/ })).toBeNull();
  fireEvent.click(headerSwitch());
  fireEvent.click(screen.getByRole("button", { name: "Next 1 row" }));
  expect([numbers(), screen.getByText("Rows 201–201 of 201") !== null]).toEqual([[201], true]);
  // The header back on: two pages are left, and the reader is on the last of them.
  fireEvent.click(headerSwitch());
  expect([numbers()[0], numbers().at(-1)]).toEqual([102, 201]);
  fireEvent.click(screen.getByRole("button", { name: "Previous 100 rows" }));
  expect([numbers()[0], numbers().at(-1)]).toEqual([2, 101]);
});

test("a file over the table's byte limit is not asked for; a body that outruns it stops and says why", async () => {
  const { fetcher } = open("big.csv", "a,b\n", { size: DELIMITED_MAX_BYTES + 1 });
  expect(screen.getByText(/Files over 2 MB are not shown as a table/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "big.csv" })).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
  cleanup(); queryClient.clear(); vi.restoreAllMocks();
  // Listed under the limit, but its body is longer (it grew, or the size was wrong).
  open("grown.csv", new Uint8Array(DELIMITED_MAX_BYTES + 1).fill(0x61), { size: 10 });
  expect(await screen.findByText(/Files over 2 MB are not shown as a table/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a failed read is the reader's failure with its retry, and the retry reads the file again", async () => {
  const data = "a\n1\n";
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => ++calls === 1 ? new Response("no", { status: 500 }) : new Response(data));
  const files = [{ name: "flaky.csv", size: data.length, revision: "r1", at: "2026-10-27T00:00:00.000Z" }];
  const screenState = screenData(tree({ tasks: [dto()] }));
  const task = { ...screenState.tasks[0]!, body: "", logs: [], files, requestHeads: [], extractRows: {}, reply: undefined } as TaskDetail;
  render(<TestWorkspace data={screenState}><DelimitedFile taskId={task.id} file={files[0]!} url={taskFileUrl(task.id, "flaky.csv", "r1")} /></TestWorkspace>);
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toContain("Could not read the file.");
  fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
  expect(rowsOf(await table())).toEqual([["1", "a"], ["2", "1"]]);
  expect(calls).toBe(2);
});

test("a new revision of the open file starts again from the reader's first choices and reads its new bytes", async () => {
  const { fetcher, revise } = open("again.csv", "a\n1\n");
  await table();
  fireEvent.click(wrapMark());
  fireEvent.click(headerSwitch());
  expect([wrapMark().getAttribute("aria-pressed"), headerSwitch().getAttribute("aria-checked")]).toEqual(["false", "false"]);
  revise("r2");
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  await table();
  expect([wrapMark().getAttribute("aria-pressed"), headerSwitch().getAttribute("aria-checked")]).toEqual(["true", "true"]);
});
