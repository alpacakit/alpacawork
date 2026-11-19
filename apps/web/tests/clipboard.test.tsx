import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { Toaster } from "../src/components/ui/toaster";
import { piecesClip, readPieces, textClip, writeClip, type Piece } from "../src/lib/clipboard";
import { LONG_PRESS_MS, useLongPress } from "../src/lib/long-press";
import { contentPieces, messagePieces, piecesContent } from "../src/features/coordinator/editor/clip";
import { splitMessage } from "../src/features/coordinator/editor/wire";

beforeAll(() => startI18n());
afterEach(cleanup);

const here = location.origin;
const message: Piece[] = [
  { kind: "task", address: "T159", label: "T159 Input [OptionA]" },
  { kind: "text", text: " Open the preview\nNext line <b>&" },
  { kind: "skill", invocation: "/", name: "letmesketch" },
];
/** A paste's data as the browser hands it: only what was put, by type. */
const transfer = (types: Record<string, string>) => ({ getData: (type: string) => types[type] ?? "" }) as unknown as DataTransfer;

test("references are Markdown in text/plain and marked elements in text/html, in the order they were written", () => {
  const clip = piecesClip(message);
  expect(clip.plain).toBe(`[T159 Input \\[OptionA\\]](${here}/?task=T159) Open the preview\nNext line <b>&/letmesketch`);
  const html = new DOMParser().parseFromString(clip.html!, "text/html").body;
  const outer = html.querySelector<HTMLElement>(`[data-alpacawork-origin="${here}"]`);
  // Another application keeps the spaces and line ends only because the outer span asks it to.
  expect(outer?.style.whiteSpace).toBe("pre-wrap");
  expect([...html.querySelectorAll<HTMLElement>("[data-alpacawork]")].map(node => [node.dataset.alpacawork, node.textContent, node.getAttribute("href")]))
    .toEqual([["task", "T159 Input [OptionA]", `${here}/?task=T159`], ["skill", "/letmesketch", null]]);
  // The person's words stay words: their marks are not read as elements.
  expect(html.querySelector("b")).toBeNull();
  expect(html.querySelectorAll("br")).toHaveLength(1);
  expect(html.textContent).toBe("T159 Input [OptionA] Open the previewNext line <b>&/letmesketch");
  // A text whose letters are its meaning goes as it is, and only as text.
  expect(textClip("```\n<b>\n```")).toEqual({ plain: "```\n<b>\n```", html: null });
});

test("a paste takes back the references it holds, and nothing else, from the clip this screen wrote", () => {
  const clip = piecesClip(message);
  expect(readPieces(transfer({ "text/plain": clip.plain, "text/html": clip.html! }))).toEqual(message);
  // The browser wraps what it was given; what is not words in it is not taken.
  expect(readPieces(transfer({ "text/html": `<html><head><title>x</title><style>a{}</style></head><body>${clip.html}<script>alert(1)</script><img src="x.png"></body></html>` }))).toEqual(message);
  // A kept piece says the copy it is kept in; nothing past the size a message can be is read.
  expect(readPieces(transfer({ "text/html": piecesClip([{ kind: "kept", text: "1-A", at: 0 }], "k1").html! }))).toEqual([{ kind: "kept", text: "1-A", at: 0, copy: "k1" }]);
  expect(readPieces(transfer({ "text/html": clip.html! + " ".repeat(256 * 1024) }))).toBeNull();
});

test("a pasted reference that does not lead here, or is not one, is the words it was shown as", () => {
  const html = '<p>Before <a href="https://other.example/?task=T1" data-alpacawork="task">T1 Other</a>'
    + `<a href="${here}/?task=T2&tab=files&path=a.md" data-alpacawork="task">T2 a.md</a>`
    + '<a href="javascript:alert(1)" data-alpacawork="task">T3</a>'
    + `<span data-alpacawork="task">T4</span><span data-alpacawork="skill">/two words</span>`
    + `<span data-alpacawork="skill" onclick="x()">$codex-skill</span></p><div>After</div>`;
  // A skill is taken only from this app's own copy: this HTML names no app.
  expect(readPieces(transfer({ "text/html": html }))).toEqual([{ kind: "text", text: "Before T1 OtherT2 a.mdT3T4/two words$codex-skill\nAfter" }]);
  // Without a mark, the paste is the place's own; a paste of nothing but text too.
  expect(readPieces(transfer({ "text/html": `<a href="${here}/?task=T1">T1</a>`, "text/plain": "T1" }))).toBeNull();
  expect(readPieces(transfer({ "text/plain": "data-alpacawork" }))).toBeNull();
});

test("a sent message's tasks and skills are references, a task not read here by its ID alone; its answers are its words", () => {
  const tasks = new Map([["T159", "Input"], ["T12", "Other"]]);
  const parts = splitMessage("T159（Input） 1-Option1 Review /letmesketch and T999 and T12", new Set(["letmesketch"]), tasks);
  expect(messagePieces(parts)).toEqual([
    { kind: "task", address: "T159", label: "T159 Input" },
    { kind: "text", text: " " }, { kind: "text", text: "1-Option1" }, { kind: "text", text: " Review " },
    { kind: "skill", invocation: "/", name: "letmesketch" },
    { kind: "text", text: " and " }, { kind: "task", address: "T999", label: "T999" }, { kind: "text", text: " and " },
    { kind: "task", address: "T12", label: "T12 Other" },
  ]);
});

test("a sent task whose title is not read here is linked by its ID alone, with no space left at the label's end", () => {
  const clip = piecesClip(messagePieces(splitMessage("See T9001 now", new Set(), new Map())));
  expect(clip.plain).toBe(`See [T9001](${here}/?task=T9001) now`);
  expect(clip.html).toContain(`data-alpacawork="task">T9001</a>`);
});

test("pasted into the input, a task known here and a skill the coordinator has are labels again, as known here", () => {
  const skill = { name: "letmesketch", invocation: "/" as const, description: "Picture" };
  const pieces: Piece[] = [
    { kind: "task", address: "T159", label: "T159 Old title" }, { kind: "text", text: " Review\n\nNext" },
    { kind: "skill", invocation: "/", name: "letmesketch" }, { kind: "task", address: "T404", label: "T404 Missing" },
    { kind: "skill", invocation: "/", name: "gone" },
  ];
  const content = piecesContent(pieces, address => address === "T159" ? { id: "T159", title: "Current title" } : undefined,
    name => name === skill.name ? skill : undefined, () => undefined);
  expect(content).toEqual([
    { type: "paragraph", content: [{ type: "taskLabel", attrs: { id: "T159", title: "Current title", auto: false } }, { type: "text", text: " Review" }] },
    { type: "paragraph" },
    { type: "paragraph", content: [{ type: "text", text: "Next" },
      { type: "skillLabel", attrs: { name: "letmesketch", invocation: "/" } },
      { type: "text", text: "T404 Missing" }, { type: "text", text: "/gone" }] },
  ]);
  // Copied out of the input again, it is the same references; a question's answer is its words.
  expect(contentPieces([...content, { type: "paragraph", content: [{ type: "answerLabel", attrs: { task: "T1", n: "1", name: "Option1", answer: "1-Option1" } }] }]).pieces).toEqual([
    { kind: "task", address: "T159", label: "T159 Current title" }, { kind: "text", text: " Review\n\nNext " },
    { kind: "skill", invocation: "/", name: "letmesketch" }, { kind: "text", text: " T404 Missing/gone\n" }, { kind: "kept", text: "1-Option1", at: 0 },
  ]);
  // Labels that touch stand apart by a space, as they do when sent.
  expect(piecesClip(contentPieces([{ type: "paragraph", content: [{ type: "taskLabel", attrs: { id: "T1", title: "One", auto: false } },
    { type: "answerLabel", attrs: { task: "T1", n: "1", name: "Option1", answer: "1-Option1" } }, { type: "text", text: "words" }] }]).pieces).plain).toBe(`[T1 One](${here}/?task=T1) 1-Option1 words`);
});

function stubClipboard({ write, writeText }: { write?: unknown; writeText?: unknown }) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });
}
class Item { constructor(readonly items: Record<string, Blob>) {} }

test("a clip with references is written as both types; a refused rich write is its text; a refused text is said, not success", async () => {
  await i18n.changeLanguage("en");
  render(<Toaster />);
  vi.stubGlobal("ClipboardItem", Item);
  const write = vi.fn().mockResolvedValue(undefined), writeText = vi.fn().mockResolvedValue(undefined);
  stubClipboard({ write, writeText });
  const clip = piecesClip(message);
  await expect(writeClip(clip)).resolves.toBe(true);
  const item = write.mock.calls[0]![0][0] as Item;
  expect(Object.keys(item.items)).toEqual(["text/plain", "text/html"]);
  expect(await item.items["text/plain"]!.text()).toBe(clip.plain);
  expect(await item.items["text/html"]!.text()).toBe(clip.html);
  expect(writeText).not.toHaveBeenCalled();
  expect(await screen.findByText("Copied")).toBeTruthy();

  write.mockRejectedValue(new DOMException("No", "NotAllowedError"));
  await expect(writeClip(clip, { said: false })).resolves.toBe(true);
  expect(writeText).toHaveBeenLastCalledWith(clip.plain);

  // A text clip never goes as a rich one.
  write.mockClear();
  await writeClip(textClip("pnpm build"), { said: false });
  expect(write).not.toHaveBeenCalled();
  expect(writeText).toHaveBeenLastCalledWith("pnpm build");

  writeText.mockRejectedValue(new DOMException("No", "NotAllowedError"));
  const said = screen.getAllByText("Copied").length;
  await expect(writeClip(clip)).resolves.toBe(false);
  expect(await screen.findByText(i18n.t("ui:copyFailed"))).toBeTruthy();
  expect(screen.getAllByText("Copied")).toHaveLength(said);

  // A browser without ClipboardItem writes the text.
  vi.stubGlobal("ClipboardItem", undefined);
  writeText.mockResolvedValue(undefined);
  await expect(writeClip(clip, { said: false })).resolves.toBe(true);
  expect(writeText).toHaveBeenLastCalledWith(clip.plain);
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

function Held({ onLong, onClick }: { onLong: () => void; onClick: () => void }) {
  const press = useLongPress(onLong);
  return <div data-testid="area" data-held={press.held || undefined} {...press.props}><button type="button" onClick={onClick}>T1</button></div>;
}

test("a press held still is long when let go; moved, cancelled, or let go sooner it is not, and its click opens nothing", () => {
  vi.useFakeTimers();
  const onLong = vi.fn(), onClick = vi.fn();
  render(<Held onLong={onLong} onClick={onClick} />);
  const area = screen.getByTestId("area"), button = screen.getByRole("button");
  const down = (x = 10, y = 10) => fireEvent.pointerDown(button, { pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y });
  // Let go sooner: an ordinary press on the label.
  down(); act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 50));
  fireEvent.pointerUp(button, { pointerId: 1 }); fireEvent.click(button, { detail: 1 });
  expect(onLong).not.toHaveBeenCalled(); expect(onClick).toHaveBeenCalledTimes(1);
  // Held long enough: shown held, and copied at the release; the click it ends in does not open the label.
  down(); act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
  expect(area.dataset.held).toBe("true");
  expect(fireEvent.contextMenu(button)).toBe(false);
  fireEvent.pointerUp(button, { pointerId: 1 }); fireEvent.click(button, { detail: 1 });
  expect(onLong).toHaveBeenCalledTimes(1); expect(onClick).toHaveBeenCalledTimes(1);
  expect(area.dataset.held).toBeUndefined();
  // A finger that wanders (a scroll) or a press the browser takes over is no long press.
  act(() => vi.advanceTimersByTime(1000));
  down(); fireEvent.pointerMove(button, { pointerId: 1, clientX: 10, clientY: 25 }); act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
  fireEvent.pointerUp(button, { pointerId: 1 });
  down(); act(() => vi.advanceTimersByTime(LONG_PRESS_MS)); fireEvent.pointerCancel(button, { pointerId: 1 });
  fireEvent.pointerUp(button, { pointerId: 1 });
  expect(onLong).toHaveBeenCalledTimes(1);
  // Outside a press, the menu is the page's own.
  expect(fireEvent.contextMenu(button)).toBe(true);
  vi.useRealTimers();
});
