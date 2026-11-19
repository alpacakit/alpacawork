import { expect, readOnlyTest } from "./fixtures.ts";
import { patchTask } from "./fixture/task-state.ts";

/** Thirty comments on T112, so its oldest row is far below the top of the column. */
function prepare(root: string) {
  const comments = Array.from({ length: 30 }, (_, i) => ({
    id: `L-note${String(i).padStart(2, "0")}`, kind: "reported" as const,
    at: `2026-09-25T${String(9 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00+09:00`,
    title: `Note ${i}`, description: `Body of note ${i}`, actor: { kind: "human" as const },
    fromState: "doing" as const, toState: null }));
  patchTask(root, "T112", { logs: comments });
}

const test = readOnlyTest(prepare);
test.use({ fixedTime: false });
for (const [width, height] of [[1440, 900]] as const) test.describe(`${width}×${height}`, () => {
  test.use({ viewport: { width, height } });
  test("a URL's event opens its report row, brings it into view, and the row keeps the URL", async ({ page, runtime }) => {
    test.setTimeout(90_000);
    const key = "log:T112:L-note00";
    await page.goto(`${runtime.origin}/?task=T112&event=${encodeURIComponent(key)}&agent=1`);
    const reader = page.getByRole("complementary");
    const toggle = reader.locator(`[data-report-key="${key}"] button[aria-expanded]`).first();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toBeInViewport();
    await expect(reader.locator(`[data-report-key="${key}"]`)).toContainText("Body of note 0");
    const length = await page.evaluate(() => history.length);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => new URL(page.url()).searchParams.get("event")).toBeNull();
    // A person's note is no instruction, so none stands open in a report's place; one opens from a press.
    const newer = reader.locator('[data-report-key="log:T112:L-note28"] button[aria-expanded]').first();
    await newer.click();
    await expect.poll(() => new URL(page.url()).searchParams.get("event")).toBe("log:T112:L-note28");
    expect(new URL(page.url()).searchParams.get("agent")).toBe("1");
    expect(await page.evaluate(() => history.length)).toBe(length);
    // A row the column does not have opens nothing and says nothing: the notes stay as they stand, all closed.
    await page.goto(`${runtime.origin}/?task=T112&event=log:T112:none&agent=1`);
    await expect(reader.locator('[data-report-key="log:T112:L-note29"] button[aria-expanded="false"]')).toBeVisible();
    await expect(reader.locator('[data-report-key^="log:T112:L-note"] button[aria-expanded="true"]')).toHaveCount(0);
  });
});
