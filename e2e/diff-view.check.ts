
import type { Locator, Page } from "@playwright/test";
import { commandPost } from "./command-post.ts";
import { test, expect, open, openAbout } from "./fixtures.ts";
import { SAMPLE_PROJECT } from "./fixture/sample.ts";

/**
 * A diff in a report, a file and the coordinator's own window: drawn whole at once, each file a band (its name,
 * what was done to it, how many lines it adds and removes, its folder) and its rows a line each, an added or removed
 * row's ground running to the frame's edges, an empty one's too, its +/- in the same hue, a hunk not at its file's start
 * a quiet "⋯ Line N". Its lines are kept whole, each file's code scrolling sideways under bands and marks that stand
 * still, until its wrap mark folds them all, a folded row's next lines standing in from its +/- column. The letters'
 * colours come later from the diff runtime (a Worker running @pierre/diffs and Shiki), loaded only once a diff is
 * shown; they move no letter and draw no line that was not there, in either reading. The frame, its width and the
 * code's font stay the plain code's (folded, its folding too); the copy mark copies the patch as written, a selection
 * what it covers as shown. A diff it cannot paint keeps its letters in the code's colour.
 */
test.use({ isolated: true });

// Both files start at line 1, so their rows can be painted (diff-policy.ts).
const TS = [
  "diff --git a/src/greeting.ts b/src/greeting.ts", "--- a/src/greeting.ts", "+++ b/src/greeting.ts", "@@ -1,4 +1,4 @@",
  " export function greet(name: string): string {", "-  const label = \"こんにちは\";", "-  return label + name;",
  "+  const label = \"こんばんは\";", "+  return `${label}、${name}さん`;", " }",
  "diff --git a/src/Card.tsx b/src/Card.tsx", "--- a/src/Card.tsx", "+++ b/src/Card.tsx", "@@ -1,6 +1,6 @@",
  " type Props = { title: string };", " export const Card = ({ title }: Props) => (", "-  <section className=\"card\">",
  "-    <h2>{title}</h2>", "+  <section className=\"card active\">", "+    <h2 aria-label=\"見出し\">{title.toUpperCase()}</h2>",
  "   </section>", " );"].join("\n");
// A new Markdown file in Japanese with a line longer than a phone's width.
const MD = [
  "diff --git a/docs/steps.md b/docs/steps.md", "new file mode 100644", "--- /dev/null", "+++ b/docs/steps.md", "@@ -0,0 +1,4 @@",
  "+# 手順", "+", "+- 分けるなら、成果物の種類だけで区切らず、必要な入力と共通の前提があれば、他の担当の内部を全部追わずに判断・制作・検証できる責務を目安にする。",
  "+- `pnpm test:quick` を実行する。"].join("\n");
// A hunk from the middle of a file: what came before it is unknown, so its letters stay unpainted; its rows are drawn.
const MIDDLE = ["diff --git a/src/comment.ts b/src/comment.ts", "--- a/src/comment.ts", "+++ b/src/comment.ts", "@@ -5,3 +5,3 @@",
  "  * hidden context 3", "-const message = \"old\";", "+const message = \"new\";", "  * hidden context 4"].join("\n");
const BODY = `Before the diffs.\n\n\`\`\`diff\n${TS}\n\`\`\`\n\n\`\`\`\n${TS}\n\`\`\`\n\n\`\`\`patch\n${MD}\n\`\`\`\n\n\`\`\`\n${MD}\n\`\`\`\n\n\`\`\`diff\n${MIDDLE}\n\`\`\`\n\n\`\`\`ts\nconst kept = 1;\n\`\`\`\n\nAfter the diffs.`;
/** The body's code blocks in order, and which of them is a diff with its plain twin. */
const BLOCKS = [TS, TS, MD, MD, MIDDLE, "const kept = 1;"];
const TWINS = [[0, 1], [2, 3]] as const;
/**
 * What each diff fixture is drawn as: its files' bands (each piece as read: the name with what was done to it, the
 * lines added and removed, the folder), then its rows' kinds. The test knows its own fixtures; the screen is told by describeDiff.
 */
const DRAWN = new Map<string, { bands: string[][]; kinds: string[] }>([
  [TS, { bands: [["greeting.ts", "+2 −2", "src/"], ["Card.tsx", "+2 −2", "src/"]], kinds: ["ctx", "del", "del", "add", "add", "ctx", "ctx", "ctx", "del", "del", "add", "add", "ctx", "ctx"] }],
  [MD, { bands: [["New steps.md", "+4", "docs/"]], kinds: ["raw", "add", "add", "add", "add"] }],
  [MIDDLE, { bands: [["comment.ts", "+1 −1", "src/"]], kinds: ["hunk", "ctx", "del", "add", "ctx"] }],
]);
/** The rows' text as written: the patch's lines but for the head lines the bands say and the hunks' `@@` lines. */
const rowsOf = (source: string) => source.split("\n").filter(line => !/^(diff --git |--- |\+\+\+ |index |@@ )/.test(line));
const RUNTIME = /diff[.-](worker|runtime)|shiki|@pierre/;

async function diffTask(page: Page, origin: string, body = BODY) {
  // Large reader samples use a workspace field; app-provided field definitions are fixed.
  const field = "diff_sample";
  const defined = await commandPost(page.request, `${origin}/api/field/set`,
    { data: { field, title: "Diff sample", type: "text", maxChars: body.length } });
  expect(defined.ok(), await defined.text()).toBe(true);
  const project = await (await page.request.get(`${origin}/api/task/get?task=${SAMPLE_PROJECT.id}`)).json();
  const schema = await (await page.request.get(`${origin}/api/field/get?task=${SAMPLE_PROJECT.id}`)).json();
  const used = await commandPost(page.request, `${origin}/api/field/use`, { data: { task: SAMPLE_PROJECT.id,
    fields: [...new Set([...schema.fields, field])], expectedTaskHash: project.task.hash } });
  expect(used.ok(), await used.text()).toBe(true);
  const made = await commandPost(page.request, `${origin}/api/task/new`, { data: { parent: SAMPLE_PROJECT.id, title: "Diff view", values: { [field]: body } } });
  expect(made.ok(), await made.text()).toBe(true);
  return (await made.json()).task.id as string;
}
async function overview(page: Page, count = BLOCKS.length) {
  const reader = page.locator("aside[data-reader-mode]");
  await openAbout(reader);
  const about = reader.locator("[data-task-about]");
  await expect(about.locator("[data-code-block]")).toHaveCount(count);
  return about;
}
const PAINTED = "[data-diff-line] [style*='--code-light']";
const isFolded = (block: Locator) => block.evaluate(frame => frame.hasAttribute("data-diff-wrap"));
const painted = (block: Locator) => expect(block.locator(PAINTED).first()).toBeAttached({ timeout: 20_000 });

/** A diff's bands, each piece as read (the copy mark aside), and its rows' kinds and text. */
function drawn(block: Locator) {
  return block.evaluate((frame: HTMLElement) => ({
    bands: [...frame.querySelectorAll<HTMLElement>("[data-diff-file] > div:first-child")].map(band =>
      [...band.firstElementChild!.children, ...[...band.children].slice(1)].filter(piece => !piece.querySelector("button")).map(piece => piece.textContent)),
    kinds: [...frame.querySelectorAll<HTMLElement>("pre > span")].map(row => row.dataset.diffLine),
    rows: [...frame.querySelectorAll<HTMLElement>("pre > span")].map(row => row.textContent!.replace(/\n$/, "")),
  }));
}

/**
 * What a block is on the screen: its letters, frame and code's font, without its colours. Its letters are where they
 * stand: each line's top and the left and right of its letters, read from the text itself (a Range over each text node,
 * the bands' too), so the elements that hold painted letters (a row, a span) count for nothing but where they put a letter.
 */
function shape(block: Locator) {
  return block.evaluate((frame: HTMLElement) => {
    const doc = frame.ownerDocument, pre = frame.querySelector("pre")!, box = frame.getBoundingClientRect();
    const lines = new Map<number, [number, number]>();
    const texts = doc.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node; node = texts.nextNode()) {
      const range = doc.createRange(); range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (!rect.width) continue;
        const top = Math.round(rect.top - box.top), at = lines.get(top);
        lines.set(top, at ? [Math.min(at[0], rect.left - box.left), Math.max(at[1], rect.right - box.left)] : [rect.left - box.left, rect.right - box.left]);
      }
    }
    const style = getComputedStyle(frame), code = getComputedStyle(pre);
    return { text: [...frame.querySelectorAll("pre")].map(each => each.textContent).join(""), width: box.width, height: box.height,
      folds: [...lines].sort(([a], [b]) => a - b).map(([top, [left, right]]) => [top, left, right] as const),
      frame: [style.padding, style.borderTopWidth, style.borderRadius, style.backgroundColor],
      code: [code.fontFamily, code.fontSize, code.lineHeight, code.whiteSpace, code.overflowWrap] };
  });
}

/**
 * What is outside a block's rows, the place's whatever is drawn inside: its width, frame and code font. Kept whole, a
 * diff's code is the same font with its lines unfolded.
 */
const outside = ({ width, frame, code }: Awaited<ReturnType<typeof shape>>, whole = false) =>
  ({ width, frame, code: whole ? [...code.slice(0, 3), "pre", code[4]] : code });

/**
 * A diff as laid out: each band's box against the frame's inside (between its borders), each code's too, and each
 * row's against its code's whole width (what it scrolls through, its lines kept whole); a row's ground, the left of its
 * letters on each line it folds into and the right of its last, with the code's column width and the frame's padding.
 */
function rows(block: Locator) {
  return block.evaluate((frame: HTMLElement) => {
    const doc = frame.ownerDocument, view = doc.defaultView!, box = frame.getBoundingClientRect();
    const inside = [box.left + frame.clientLeft, box.left + frame.clientLeft + frame.clientWidth], top = box.top + frame.clientTop, foot = top + frame.clientHeight;
    const pre = frame.querySelector("pre")!;
    // A column: the width of the code's first letter (an ASCII one, as every +/- is).
    const first = doc.createRange(), text = doc.createTreeWalker(pre, NodeFilter.SHOW_TEXT).nextNode()!;
    first.setStart(text, 0); first.setEnd(text, 1);
    const at = (element: HTMLElement, sides = inside) => { const r = element.getBoundingClientRect(); return { edges: [r.left - sides[0]!, sides[1]! - r.right], ends: [r.top - top, foot - r.bottom] }; };
    // What a code scrolls through: from its inside's left, less what it has scrolled, as wide as it scrolls.
    const through = (code: HTMLElement) => { const left = code.getBoundingClientRect().left + code.clientLeft - code.scrollLeft; return [left, left + code.scrollWidth]; };
    const bands = [...frame.querySelectorAll<HTMLElement>("[data-diff-file] > div:first-child")];
    const codes = [...frame.querySelectorAll<HTMLElement>("[data-diff-code]")];
    const shown = [...frame.querySelectorAll<HTMLElement>("pre > span")];
    // What meets the frame's top and its foot: the first band or row, the last row or band.
    const order = [...frame.querySelectorAll<HTMLElement>("[data-diff-file] > div:first-child, pre > span")];
    return { column: first.getBoundingClientRect().width, top: at(order[0]!).ends[0]!, foot: at(order.at(-1)!).ends[1]!,
      bleed: parseFloat(view.getComputedStyle(frame).paddingInlineEnd),
      bands: bands.map(band => ({ ...at(band), ground: view.getComputedStyle(band).backgroundColor })),
      codes: codes.map(code => ({ ...at(code), scrolls: code.scrollWidth > code.clientWidth })),
      rows: shown.map(row => {
        const range = doc.createRange(); range.selectNodeContents(row);
        const lines = new Map<number, number>();
        let right = -Infinity;
        for (const rect of range.getClientRects()) if (rect.width) {
          lines.set(Math.round(rect.top), Math.min(lines.get(Math.round(rect.top)) ?? Infinity, rect.left));
          right = Math.max(right, rect.right);
        }
        const sides = through(row.closest<HTMLElement>("[data-diff-code]")!);
        return { kind: row.dataset.diffLine!, text: row.textContent!.replace(/\n$/, ""), ...at(row, sides),
          ground: view.getComputedStyle(row).backgroundColor, lefts: [...lines].sort(([a], [b]) => a - b).map(([, left]) => left), past: sides[1]! - right };
      }) };
  });
}

/**
 * A diff drawn as bands and rows, painted or not: every band and code spans the frame between its borders and every
 * row its code's whole width (so a short row's ground is as long as the longest), the first meets its top and the last
 * its foot, a band and an added or removed row have a ground and nothing else does, and each row's last letter stands
 * the frame's padding or more before its code's end. Kept whole, a row is one line; folded, a row's next lines start
 * where its text starts after its +/- column (that line's indent, up to 8) and two columns more.
 */
async function checkRows(block: Locator) {
  const whole = !await isFolded(block);
  const laid = await rows(block);
  expect(Math.abs(laid.top), "the first band or row to the frame's top").toBeLessThan(0.5);
  expect(Math.abs(laid.foot), "the last row or band to the frame's foot").toBeLessThan(0.5);
  for (const band of laid.bands) {
    for (const edge of band.edges) expect(Math.abs(edge), "a band to the frame's edge").toBeLessThan(0.5);
    expect(band.ground).not.toBe("rgba(0, 0, 0, 0)");
  }
  for (const code of laid.codes) {
    for (const edge of code.edges) expect(Math.abs(edge), "a code to the frame's edge").toBeLessThan(0.5);
    if (!whole) expect(code.scrolls, "a folded code does not scroll").toBe(false);
  }
  for (const row of laid.rows) {
    for (const edge of row.edges) expect(Math.abs(edge), `${row.text}: ground to its code's edge`).toBeLessThan(0.5);
    expect(row.ground === "rgba(0, 0, 0, 0)", `${row.text}: its ground`).toBe(!/add|del/.test(row.kind));
    if (row.text.trim()) expect(row.past, `${row.text}: its last letter before the code's end`).toBeGreaterThan(laid.bleed - 0.5);
    if (whole) { expect(row.lefts.length, `${row.text}: one line`).toBeLessThanOrEqual(1); continue; }
    if (row.kind === "hunk") continue;
    const hang = (1 + Math.min(/^ */.exec(row.text.slice(1))![0].length, 8) + 2) * laid.column;
    for (const left of row.lefts.slice(1)) expect(Math.abs(left - row.lefts[0]! - hang), `${row.text}: a fold stands in`).toBeLessThan(0.5);
  }
  return laid;
}

/**
 * Every word and painted letter's colour against the ground it is read on (its band's or row's, else the frame's), in
 * sRGB through a canvas (a computed colour may be OKLCH), with the colour it should show in the applied theme: a painted
 * letter's is the diff's (--code-light, --code-dark), a +/- is its row's hue, a band's words and a quiet row their own.
 */
function letters(block: Locator) {
  return block.evaluate((frame: HTMLElement) => {
    const doc = frame.ownerDocument, view = doc.defaultView!;
    const canvas = doc.createElement("canvas"); canvas.width = canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true })!;
    // A colour as shown over what lies under it (a ground may be see-through: a band is a tint of ink).
    const srgb = (...colours: string[]) => { paint.clearRect(0, 0, 1, 1); for (const colour of colours) { paint.fillStyle = colour; paint.fillRect(0, 0, 1, 1); } return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
    const lum = (c: number[]) => c.map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i]!, 0);
    const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + .05) / (y! + .05); };
    const dark = doc.documentElement.dataset.theme === "dark";
    const frameGround = view.getComputedStyle(frame).backgroundColor;
    const grounds = (element: Element) => {
      const under: string[] = [];
      for (let at: Element | null = element; at && at !== frame; at = at.parentElement) under.unshift(view.getComputedStyle(at).backgroundColor);
      return [frameGround, ...under];
    };
    // Every element holding a word of its own: a band's pieces, a quiet row, a +/- or a painted run.
    const words = [...frame.querySelectorAll<HTMLElement>("[data-diff-file] > div:first-child *, [data-diff-line=raw], [data-diff-line=hunk], [data-diff-line] span")]
      .filter(element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()));
    return words.map(span => {
      const ground = srgb(...grounds(span));
      const shown = srgb(...grounds(span), view.getComputedStyle(span).color);
      const given = span.style.getPropertyValue(dark ? "--code-dark" : "--code-light");
      const meant = given ? srgb(given) : shown;
      return { kind: span.closest<HTMLElement>("[data-diff-line]")?.dataset.diffLine ?? "band", text: span.textContent, contrast: ratio(shown, ground), shown: shown.join(), meant: meant.join(),
        weight: view.getComputedStyle(span).fontWeight, style: view.getComputedStyle(span).fontStyle };
    });
  });
}

/**
 * One block drawn twice folds alike: the same lines at the same tops, and each line's letters from the same left to the same right.
 * Letters split into painted runs are placed by the browser in floating point; they may land a few hundredths of a pixel
 * apart (0.031px seen), so a line's ends may differ by under a quarter pixel. An indent or spacing moves them by pixels.
 */
function expectSameShape(a: Awaited<ReturnType<typeof shape>>, b: Awaited<ReturnType<typeof shape>>) {
  const { folds: folded, ...rest } = a, { folds: twin, ...twinRest } = b;
  expect(rest).toEqual(twinRest);
  expect(folded.map(([top]) => top)).toEqual(twin.map(([top]) => top));
  folded.forEach(([top, left, right], i) => {
    expect(Math.abs(left - twin[i]![1]), `line at ${top}: left`).toBeLessThan(0.25);
    expect(Math.abs(right - twin[i]![2]), `line at ${top}: right`).toBeLessThan(0.25);
  });
}

/**
 * A diff as drawn, painted or not, in the reading its wrap mark is in: its bands and rows as describeDiff reads its
 * source, no git line, the rows' text as written, the same outside as its plain twin (its lines kept whole, unfolded),
 * every word readable.
 */
async function checkDrawn(block: Locator, twin: Locator, source: string) {
  const { bands, kinds, rows: text } = await drawn(block);
  expect({ bands, kinds }).toEqual(DRAWN.get(source));
  expect(text.filter((_, i) => kinds[i] !== "hunk")).toEqual(rowsOf(source));
  expect(await block.evaluate(frame => /diff --git|^\+\+\+ |^--- |^@@/m.test(frame.textContent!))).toBe(false);
  expect(outside(await shape(block))).toEqual(outside(await shape(twin), !await isFolded(block)));
  await checkRows(block);
  const marks = await letters(block);
  for (const mark of marks) expect(mark.contrast, `${mark.text} (${mark.kind})`).toBeGreaterThanOrEqual(4.5);
  return marks;
}

/**
 * A painted diff: drawn as it should be, its letters painted in the applied theme's colours with no weight or slant,
 * and, given how it was drawn before its colours came (`raw`), not a letter moved.
 */
async function checkPainted(block: Locator, twin: Locator, source: string, raw?: Awaited<ReturnType<typeof shape>>) {
  // A diff is painted once it is on the screen, as a reader scrolls to it.
  await block.scrollIntoViewIfNeeded();
  await painted(block);
  if (raw) expectSameShape(await shape(block), raw);
  const marks = await checkDrawn(block, twin, source);
  for (const mark of marks) {
    expect(mark.shown).toBe(mark.meant);
    if (mark.kind !== "band" && mark.kind !== "hunk") expect([mark.weight, mark.style]).toEqual(["400", "normal"]);
  }
  return marks;
}

test("what paints a diff is loaded only once a diff is shown, and a diff it cannot load is drawn all the same, unpainted", async ({ page, runtime }) => {
  test.setTimeout(60_000);
  const asked: string[] = [];
  page.on("request", request => { if (RUNTIME.test(request.url())) asked.push(request.url()); });
  await open(page, runtime, "?task=T111&theme=light");
  await openAbout(page.locator("aside[data-reader-mode]"));
  expect(asked).toEqual([]);
  const task = await diffTask(page, runtime.origin);
  // The runtime cannot be fetched: the diffs stay as they are drawn, bands and rows, with no word or mark added.
  await page.route(RUNTIME, route => route.abort());
  await open(page, runtime, `?task=${task}&theme=light`);
  const about = await overview(page);
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  await expect(about.locator(PAINTED)).toHaveCount(0);
  const blocks = about.locator("[data-code-block]");
  const unpainted = new Map<number, Awaited<ReturnType<typeof shape>>>();
  for (const [diff, twin] of TWINS) {
    await checkDrawn(blocks.nth(diff), blocks.nth(twin), BLOCKS[diff]!);
    unpainted.set(diff, await shape(blocks.nth(diff)));
  }
  expect(await about.innerText()).toContain("After the diffs.");
  await page.unroute(RUNTIME);
  // Opened again, it paints, every letter where it stood unpainted.
  await open(page, runtime, `?task=${task}&theme=light`);
  const again = (await overview(page)).locator("[data-code-block]");
  for (const [diff, twin] of TWINS) await checkPainted(again.nth(diff), again.nth(twin), BLOCKS[diff]!, unpainted.get(diff));
});
