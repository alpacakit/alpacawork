import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { commandPost } from "./command-post.ts";
import { publishFixtureFiles } from "./fixture-writes.ts";
import { SAMPLE_PROJECT } from "./fixture/sample.ts";
import { placeResponsible } from "./fixture/responsible.ts";
import { seedReview, taskFolder } from "./fixture/task-state.ts";
import { test, expect, open, openFile, keepShot } from "./fixtures.ts";
import { configureCoordinator } from "./coordinator-fixture.ts";
import { DELIMITED_MAX_BYTES, DELIMITED_MAX_ROWS } from "../apps/web/src/domain/delimited-file.ts";

/**
 * A CSV or TSV file of a Task, read in the viewer, is a table: its records as written, the first the header until the reader
 * turns that off, long cells folded until the wrap mark (the diff's) keeps them whole, 100 records a page. The table
 * alone scrolls sideways; the page, the reader and its last controls stay clear at a phone's width, half or whole
 * screen, and on a computer. A selection copies the values as written. The encoding is found from the bytes (UTF-8, else
 * Shift_JIS), never asked of the reader, and what the table cannot hold (a file over 2 MB, records past the limit, bytes
 * neither reads) is said, never dropped quietly. Over the table one line holds the record count, the header switch and
 * the two marks, the last of them saving the original as it is. A report's file link and an instruction's attached file
 * open the same table.
 */
test.use({ isolated: true });

const LONG = "長い文がセルの中で折り返されて、横に動かさずに最後まで読めることを確かめるための文です。";
/** A mapping table: six columns, the third and fifth long sentences, 144 records with its header. */
const MAPPING = [["旧ファイル", "旧行", "旧文", "扱い", "行き先", "理由"],
  ...Array.from({ length: 143 }, (_, i) => [`SKILL-${i % 7}.md`, String(i + 1), `${i}: ${LONG.repeat(1 + i % 3)}`, i % 2 ? "残す" : "移す",
    `references/part-${i}.md の「${LONG}」`, i % 5 ? "" : "重複のため"])];
const tsv = (rows: string[][]) => rows.map(row => row.join("\t")).join("\n") + "\n";
/** A quoted line break, leading zeros, a quote and a comma in a cell, a duplicate and an empty header, uneven records and a huge cell. */
const HUGE = "巨".repeat(3000) + "END";
const QUIRKS = ['名前,名前,,備考', '"山田\n太郎",007,,"引用符 ""付き"" と, カンマ"', '佐藤,0012', '鈴木,1,2,3,4', `巨大,x,,${HUGE}`].join("\r\n") + "\r\n";
/** A long Markdown file, its last line to be read clear of what floats at the foot. */
const LAST_LINE = "The last line of the file.";
const LONG_MD = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}. ${LONG}`).join("\n\n") + `\n\n${LAST_LINE}\n`;
/** 名前,コード / 山田,007 in Shift_JIS. */
const SJIS = Buffer.from([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x83, 0x52, 0x81, 0x5b, 0x83, 0x68, 0x0a, 0x8e, 0x52, 0x93, 0x63, 0x2c, 0x30, 0x30, 0x37, 0x0a]);
/** UTF-8 with its byte order mark: the table reads past the mark, the original keeps it. */
const BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("名前,コード\r\n佐藤,0012\r\n")]);
/** A record and then a lone lead byte: neither UTF-8 nor Shift_JIS. */
const UNREADABLE = Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0x81]);

async function prepare(page: Page, runtime: { origin: string; root: string }) {
  const made = await commandPost(page.request, `${runtime.origin}/api/task/new`, { data: { parent: SAMPLE_PROJECT.id, title: "Tables in files" } });
  expect(made.ok(), await made.text()).toBe(true);
  const id = (await made.json()).task.id as string;
  const folder = taskFolder(runtime.root, id);
  writeFileSync(join(folder, "mapping.tsv"), tsv(MAPPING));
  writeFileSync(join(folder, "quirks.csv"), QUIRKS);
  writeFileSync(join(folder, "sjis.csv"), SJIS);
  writeFileSync(join(folder, "bom.csv"), BOM);
  writeFileSync(join(folder, "unreadable.csv"), UNREADABLE);
  writeFileSync(join(folder, "many.csv"), Array.from({ length: DELIMITED_MAX_ROWS + 20 }, (_, i) => `${i},value ${i}`).join("\n") + "\n");
  writeFileSync(join(folder, "big.csv"), Buffer.alloc(DELIMITED_MAX_BYTES + 1, "a,b\n"));
  writeFileSync(join(folder, "long.md"), LONG_MD);
  publishFixtureFiles(runtime.root);
  return id;
}

const reader = (page: Page) => page.locator("aside[data-reader-mode]");
/** The table in the viewer it is read in. */
const tableOf = (page: Page) => page.locator("[data-viewer] section[data-delimited]");
/** The file reads asked of the server, to tell a choice that reads nothing again. */
function fileReads(page: Page) {
  const asked: string[] = [];
  page.on("request", request => { if (/\/api\/tasks\/[^/]+\/file\?/.test(request.url())) asked.push(new URL(request.url()).searchParams.get("path")!); });
  return asked;
}

type Fit = { pageWide: boolean; readerWide: boolean; tableScrolls: boolean; covered: string[] };

/**
 * With the reader scrolled to its end, what floats over the last of `last` (a line or a control): the task's bar on a
 * computer, the coordinator's input, the row over its input while it is folded (the way in, the task's moves) and its
 * open conversation, each named with how many pixels it covers. One that covers the whole reader (a phone's open
 * conversation) leaves nothing to keep clear. The room is the shared reader's foot (--coordinator-dock,
 * CoordinatorCard), the same for any content: none of it is the table's own.
 */
function coveredAtEnd(last: Element): Promise<string[]> {
  const content = last.closest<HTMLElement>("[data-viewer-scroll]")!;
  content.scrollTop = content.scrollHeight;
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
    const range = document.createRange(); range.selectNodeContents(last);
    const lines = [...range.getClientRects()].filter(rect => rect.width && rect.height);
    const foot = lines.length ? lines.at(-1)! : last.getBoundingClientRect();
    const surfaces = [["input", "[data-coordinator-card] [data-composer-frame], [data-coordinator-card] [data-coordinator-capsule]"],
      ["fold-row", "[data-coordinator-fold-row] > *"], ["conversation", "[data-coordinator-panel]"]] as const;
    // A surface covers the foot where it is drawn over it: one under the viewer (a phone's, the whole screen) covers nothing.
    const onTop = (element: Element, box: DOMRect) => element.contains(document.elementFromPoint(
      (Math.max(box.left, foot.left) + Math.min(box.right, foot.right)) / 2, (Math.max(box.top, foot.top) + Math.min(box.bottom, foot.bottom)) / 2));
    resolve(surfaces.flatMap(([name, selector]) => [...document.querySelectorAll(selector)].map(element => [element, element.getBoundingClientRect()] as const)
      .filter(([element, box]) => box.height > 0 && box.width > 0 && box.left < foot.right && box.right > foot.left && box.top < foot.bottom - 0.5 && box.bottom > foot.top
        && box.top > content.getBoundingClientRect().top && onTop(element, box))
      .map(([, box]) => `${name} ${Math.round(foot.bottom - box.top)}px`)));
  })));
}

/** Whether the page or the reader is wider than the screen, whether the table scrolls in its frame, and what covers its foot. */
async function fit(page: Page): Promise<Fit> {
  await page.evaluate(`window.coveredAtEnd = ${coveredAtEnd.toString()}`);
  return tableOf(page).evaluate(async section => {
    const content = section.closest<HTMLElement>("[data-viewer-scroll]")!;
    const frame = section.querySelector("table")!.parentElement!;
    const covered = await (window as unknown as { coveredAtEnd: (last: Element) => Promise<string[]> }).coveredAtEnd(section.lastElementChild!);
    return {
      pageWide: document.documentElement.scrollWidth > innerWidth + 1,
      readerWide: content.scrollWidth > content.clientWidth + 1,
      tableScrolls: frame.scrollWidth > frame.clientWidth + 1,
      covered,
    };
  });
}

/** Selects `target`, copies it and reads the clipboard: a cell's words (as a hand drags over them), or a whole row. */
async function copied(page: Page, target: Locator) {
  await target.evaluate(element => {
    const range = document.createRange();
    if (element.matches("tr")) range.selectNode(element); else range.selectNodeContents(element);
    const selected = getSelection()!; selected.removeAllRanges(); selected.addRange(range);
  });
  await page.keyboard.press("ControlOrMeta+C");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  await page.evaluate(() => getSelection()?.removeAllRanges());
  return clip;
}

for (const [size, viewport] of [["phone", { width: 390, height: 844 }], ["pc", { width: 1280, height: 900 }]] as const) {
  test.describe(size, () => {
    if (size === "phone") test.use({ viewport, hasTouch: true, isMobile: true });
    else test.use({ viewport });

    // What is read from the bytes is the same at any size (domain/delimited-file.ts): the phone also holds the tightest fit for the huge cell.
    if (size === "phone") test(`what a file holds is shown as written, its oddities said, and what the table cannot hold never dropped quietly (${size})`, async ({ page, runtime }) => {
      test.setTimeout(120_000);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: runtime.origin });
      const id = await prepare(page, runtime);
      const asked = fileReads(page);
      await openFile(page, runtime, id, "quirks.csv", "&theme=light");
      const table = tableOf(page);
      await expect(table.locator("table")).toBeVisible();
      // A duplicate and an empty header stay as written; a quoted line break, leading zeros, quotes and commas too.
      await expect(table.locator("thead th[scope=col]")).toHaveText(["名前", "名前", "", "備考"]);
      const first = table.locator("tbody tr").first();
      await expect(first.locator("td").nth(0)).toHaveText("山田\n太郎");
      expect(await copied(page, first.locator("td").nth(0))).toBe("山田\n太郎");
      expect(await copied(page, first.locator("td").nth(1))).toBe("007");
      expect(await copied(page, first.locator("td").nth(3))).toBe('引用符 "付き" と, カンマ');
      // Records of other widths: said above the table, the cells a record lacks hatched, its extra cell kept.
      await expect(table.getByRole("status")).toContainText("different numbers of columns");
      expect(await table.locator("tbody tr").nth(1).locator("td").evaluateAll(cells => cells.map(cell => cell.hasAttribute("data-missing") ? null : cell.textContent)))
        .toEqual(["佐藤", "0012", null, null, null]);
      await expect(table.locator("tbody tr").nth(2).locator("td")).toHaveText(["鈴木", "1", "2", "3", "4"]);
      // A huge cell is whole, folded within the screen, and copied whole.
      const huge = table.locator("tbody tr").nth(3).locator("td").nth(3);
      await expect(huge).toHaveText(HUGE);
      expect(await copied(page, huge)).toBe(HUGE);
      expect(await fit(page)).toMatchObject({ pageWide: false, readerWide: false, covered: [] });
      await keepShot(page, `delimited-quirks-${size}`);

      // Shift_JIS: read as it is, with nothing asked of the reader and no encoding to choose.
      await openFile(page, runtime, id, "sjis.csv", "&theme=light");
      await expect(tableOf(page).locator("thead th[scope=col]")).toHaveText(["名前", "コード"]);
      await expect(tableOf(page).locator("tbody td")).toHaveText(["山田", "007"]);
      await expect(tableOf(page).getByRole("status")).toHaveCount(0);
      await expect(tableOf(page).getByRole("combobox")).toHaveCount(0);
      expect(asked.filter(path => path === "sjis.csv")).toHaveLength(1);
      await keepShot(page, `delimited-sjis-${size}`);

      // Neither UTF-8 nor Shift_JIS: one plain reason and the original, no table and no marks over nothing.
      await openFile(page, runtime, id, "unreadable.csv", "&theme=light");
      await expect(tableOf(page).getByRole("status")).toContainText("character encoding could not be recognized");
      await expect(tableOf(page).getByRole("link", { name: /^Original file/ })).toBeVisible();
      await expect(tableOf(page).locator("table, [data-delimited-head]")).toHaveCount(0);

      // Past the record limit: said, with the original's link; ten pages of what was read.
      await openFile(page, runtime, id, "many.csv", "&theme=light");
      await expect(tableOf(page).getByRole("status")).toContainText(`Only the first ${DELIMITED_MAX_ROWS} rows are shown`);
      await expect(tableOf(page).getByText(`Rows 2–101 of ${DELIMITED_MAX_ROWS}`)).toBeVisible();

      // Over 2 MB: not read at all, the original linked.
      await openFile(page, runtime, id, "big.csv", "&theme=light");
      await expect(page.locator("[data-viewer]").getByText(/Files over 2 MB are not shown as a table/)).toBeVisible();
      await expect(page.locator("[data-viewer]").getByRole("link", { name: "big.csv" })).toBeVisible();
      expect(asked).not.toContain("big.csv");
    });
  });
}

/** What a download mark saved: its name and its bytes, beside the file's on the server's disk. */
async function saved(page: Page, root: string, id: string, mark: Locator, name: string) {
  const [download] = await Promise.all([page.waitForEvent("download"), mark.click()]);
  return { name: download.suggestedFilename(), same: readFileSync((await download.path())!).equals(readFileSync(join(taskFolder(root, id), name))) };
}

test.describe("from a report", () => {
  test.use({ locale: "ja-JP", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("a report's file links and an instruction's attached file open the table, whose viewer saves the original as it is", async ({ page, runtime }) => {
    test.setTimeout(120_000);
    configureCoordinator(runtime.root);
    const id = await prepare(page, runtime);
    await placeResponsible(page.request, runtime.origin, (await (await page.request.get(`${runtime.origin}/api/task/get?task=${id}`)).json()).task, "fake");
    mkdirSync(join(taskFolder(runtime.root, id), "attachments"));
    writeFileSync(join(taskFolder(runtime.root, id), "attachments", "sent.tsv"), "品目\t数量\nみかん\t012\n");
    publishFixtureFiles(runtime.root);
    // A relative link, a name in code, and this server's file URL: each the Files tab's file. Code is code, never a table.
    seedReview(runtime.root, id, { title: "表を確認してください", description: [
      "相対: [対応表](mapping.tsv)、コード: `bom.csv`、",
      `URL: [Shift_JIS](${runtime.origin}/api/tasks/${id}/file?path=sjis.csv)`,
      "", "```csv", "名前,コード", "```"].join("\n") });
    const current = await (await page.request.get(`${runtime.origin}/api/task/get?task=${id}`)).json();
    const sent = await commandPost(page.request, `${runtime.origin}/api/task/request`, { data: { task: id, opId: crypto.randomUUID(),
      body: `添付の表です\n\n[sent.tsv](/api/tasks/${id}/file?path=${encodeURIComponent("attachments/sent.tsv")})`,
      expectedTaskHash: current.task.hash, expectedPlacementRevision: current.agents.find((agent: { active: boolean; responsible: boolean }) => agent.active && agent.responsible).revision } });
    expect(sent.ok(), await sent.text()).toBe(true);
    const feed = reader(page).locator("[data-report-feed]");
    /** The History row with these words (in its head when closed, its body when open), open. */
    const row = async (words: string) => {
      await open(page, runtime, `?task=${id}&theme=light&agent=1`);
      const item = feed.locator("[data-report-key]").filter({ hasText: words }).first();
      const head = item.locator("button[aria-expanded]").first();
      if (await head.getAttribute("aria-expanded") === "false") await head.click();
      await expect(head).toHaveAttribute("aria-expanded", "true");
      return item;
    };
    const report = await row("表を確認してください");
    await expect(report.locator("pre")).toContainText("名前,コード");
    // The file itself is saved from the viewer's head, whatever the table drew from it.
    const download = () => page.locator("[data-viewer-head]").getByRole("link", { name: "ファイルをダウンロード" });
    for (const [label, name, first] of [["対応表", "mapping.tsv", MAPPING[1]![0]!], ["bom.csv", "bom.csv", "佐藤"], ["Shift_JIS", "sjis.csv", "山田"]] as const) {
      await (await row("表を確認してください")).getByRole("link", { name: label, exact: true }).click();
      await expect(tableOf(page).locator("tbody tr").first().locator("td").first()).toHaveText(first);
      expect(await saved(page, runtime.root, id, download(), name), name).toEqual({ name, same: true });
    }
    // A choice changes only the drawing: the original saved after it is the same bytes.
    await tableOf(page).getByRole("switch", { name: "1行目を見出し" }).click();
    await tableOf(page).locator("[data-delimited-head] button[aria-pressed]").click();
    expect(await saved(page, runtime.root, id, download(), "sjis.csv")).toEqual({ name: "sjis.csv", same: true });
    await (await row("添付の表です")).getByRole("button", { name: /sent\.tsv/ }).click();
    await expect(tableOf(page).locator("tbody tr").first().locator("td")).toHaveText(["みかん", "012"]);
    expect(await saved(page, runtime.root, id, download(), "attachments/sent.tsv")).toEqual({ name: "sent.tsv", same: true });
    // Past the table's limit, the original holds every record.
    await openFile(page, runtime, id, "many.csv", "&theme=light");
    await expect(tableOf(page).getByRole("status").filter({ hasText: String(DELIMITED_MAX_ROWS) })).toBeVisible();
    expect(await saved(page, runtime.root, id, download(), "many.csv")).toEqual({ name: "many.csv", same: true });
  });
});
