import { notify, recordFailure } from "./notify";
import { i18n } from "@alpacawork/i18n";
import { webTarget } from "@/domain/web-link";
import { screenLink } from "@/state/screen-settings";

/**
 * What a copy puts on the clipboard, and what a paste takes back from it. Two kinds of copy:
 * - a text whose every letter is its meaning (code, YAML, a path, an address, a report's Markdown) goes as that text
 *   alone (`textClip`), so a rich place to paste it into adds no formatting to it either;
 * - words that hold references (a message's tasks and skills, a task's name) go as `Piece`s (`piecesClip`): text/plain
 *   as Markdown, where a task is a link to its screen, so a plain place (a notepad) reads it; text/html the same in
 *   order, a task an `<a>` and a skill a `<span>` marked `data-alpacawork`, in a `<span>` that names the app it came
 *   from (its origin), which is what this screen restores as chips.
 * A paste trusts nothing it reads (`readPieces`): it takes from marked elements only a task's address, from a link
 * to this screen, and, from this app's own copy, a skill's name and a kept piece's place; what they are is looked up
 * where it is pasted, so a reference from another server, or one not known here, stays the words it was shown as.
 */
export type Piece = { kind: "text"; text: string } | { kind: "task"; address: string; label: string }
  | { kind: "skill"; name: string; invocation: "/" | "$" }
  /** Words this page keeps more of (`at`, in the copy named `copy`, as read): elsewhere they are their words. */
  | { kind: "kept"; text: string; at: number; copy?: string };
export type Clip = { plain: string; html: string | null };

export const textClip = (text: string): Clip => ({ plain: text, html: null });

const MARK = "data-alpacawork";
/** The app's origin: the coordinator's own window (about:blank) is the app's too. */
const appOrigin = () => location.origin;
const taskHref = (address: string) => new URL(screenLink({ task: address }), appOrigin()).href;
const markdownLabel = (label: string) => label.replace(/[\\[\]]/g, "\\$&");
const escape = (text: string) => text.replace(/[&<>"]/g, letter => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[letter]!);
const htmlText = (text: string) => escape(text).replaceAll("\n", "<br>");

/** `copy`: what names this copy to the page that made it (a random key; see `readPieces`). */
export function piecesClip(pieces: readonly Piece[], copy?: string): Clip {
  let plain = "", html = "";
  for (const piece of pieces) {
    if (piece.kind === "text") { plain += piece.text; html += htmlText(piece.text); }
    else if (piece.kind === "task") {
      const href = taskHref(piece.address);
      plain += `[${markdownLabel(piece.label)}](${href})`;
      html += `<a href="${escape(href)}" ${MARK}="task">${htmlText(piece.label)}</a>`;
    } else if (piece.kind === "skill") {
      plain += piece.invocation + piece.name;
      html += `<span ${MARK}="skill">${htmlText(piece.invocation + piece.name)}</span>`;
    } else {
      plain += piece.text;
      html += `<span ${MARK}="kept" ${MARK}-at="${piece.at}">${htmlText(piece.text)}</span>`;
    }
  }
  return { plain, html: `<span style="white-space:pre-wrap" ${MARK}-origin="${escape(appOrigin())}"${copy ? ` ${MARK}-copy="${escape(copy)}"` : ""}>${html}</span>` };
}

/**
 * The latest copy. One started before it and still writing is outdated: should the browser refuse it (as it may when
 * another write starts), it is not written again as text over what was copied since, nor said.
 */
let latest = 0;

/**
 * Copy and say whether it worked. A failure is always said, as it names what to do instead; a place that marks its
 * own success (`CopyButton`'s ✓) passes `said: false` so it is not said twice. A clip with references goes as both
 * text/plain and text/html where the browser takes several (`ClipboardItem`), else as its text/plain alone.
 * `view`: the window the press was in. The browser copies only for the focused window, and the coordinator's
 * conversation can be in a window of its own.
 */
export async function writeClip(clip: Clip, { said = true, view = window }: { said?: boolean; view?: Window } = {}): Promise<boolean> {
  const copy = ++latest;
  const clipboard = view.navigator.clipboard;
  const Item = (view as Window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  try {
    if (clip.html !== null && Item) {
      try {
        await clipboard.write([new Item({ "text/plain": new Blob([clip.plain], { type: "text/plain" }), "text/html": new Blob([clip.html], { type: "text/html" }) })]);
      } catch (refused) {
        if (copy !== latest) throw refused;
        await clipboard.writeText(clip.plain);
      }
    } else await clipboard.writeText(clip.plain);
    // Copied, but a later copy started meanwhile: what that one comes to is what is said, and shown.
    if (copy !== latest) return false;
    if (said) notify.success(i18n.t("ui:copied"), { from: view });
    return true;
  } catch (error) {
    recordFailure(error, "clipboard");
    if (copy === latest) notify.error(i18n.t("ui:copyFailed"), { from: view });
    return false;
  }
}

/** A copy or cut the browser does itself (in an input) puts the same clip, in its own event; it is the latest copy. */
export function putClip(data: DataTransfer, clip: Clip) {
  latest++;
  data.clearData();
  data.setData("text/plain", clip.plain);
  if (clip.html !== null) data.setData("text/html", clip.html);
}

const BLOCK = /^(?:P|DIV|LI|TR|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TABLE)$/;
const SKILL = /^([/$])([\p{L}\p{N}_][\p{L}\p{N}_:.-]*)$/u;
/** Past this a pasted HTML is not read for references (the paste is the place's own). */
const MAX_HTML = 256 * 1024;
/**
 * The pieces of what is pasted, when it holds at least one marked piece; `null` otherwise (the paste is the place's
 * own). It is read inertly, as a template's content (no script runs and nothing is loaded); only text, line breaks
 * and the marks are taken. A task link that does not lead to this app's task (another server's) is its words; a
 * skill and a kept piece are taken only inside this app's own copy (the `<span>` naming this app's origin, and for a
 * kept piece its key), else they are their words. A line is begun between blocks of another place's HTML; this app's
 * own breaks are its `<br>`s, kept as they are.
 */
export function readPieces(data: DataTransfer, at: Document = document): Piece[] | null {
  const html = data.getData("text/html");
  if (!html.includes(MARK) || html.length > MAX_HTML) return null;
  const template = at.createElement("template");
  template.innerHTML = html;
  const root = template.content;
  if (!root.querySelector(`[${MARK}="task"], [${MARK}="skill"], [${MARK}="kept"]`)) return null;
  const origin = appOrigin();
  const pieces: Piece[] = [];
  let line = false;
  const append = (piece: Piece) => {
    const last = pieces.at(-1);
    if (piece.kind === "text" && last?.kind === "text") last.text += piece.text;
    else if (piece.kind !== "text" || piece.text) pieces.push(piece);
  };
  const add = (piece: Piece) => {
    if (line && pieces.length) append({ kind: "text", text: "\n" });
    line = false;
    append(piece);
  };
  const text = (value: string) => { if (value) add({ kind: "text", text: value }); };
  /** `own`: the copy this node is in, when it is this app's (its key, or "" for none); `null` outside one. */
  const walk = (node: Node, own: string | null) => {
    if (node.nodeType === Node.TEXT_NODE) { text(node.textContent ?? ""); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (/^(?:SCRIPT|STYLE|TEMPLATE|TITLE|META|LINK|IFRAME|OBJECT|SVG|MATH)$/i.test(element.tagName)) return;
    if (element.tagName === "BR") { text("\n"); return; }
    if (element.hasAttribute(`${MARK}-origin`))
      own = element.getAttribute(`${MARK}-origin`) === origin ? element.getAttribute(`${MARK}-copy`) ?? "" : null;
    const words = element.textContent ?? "";
    const mark = element.getAttribute(MARK);
    if (mark === "task") {
      const target = element.tagName === "A" ? webTarget(element.getAttribute("href") ?? "", origin) : null;
      if (target?.kind === "here" && target.task && target.task.path === null && words.trim()) add({ kind: "task", address: target.task.address, label: words });
      else text(words);
      return;
    }
    if (mark === "skill") {
      const skill = own !== null ? SKILL.exec(words) : null;
      if (skill) add({ kind: "skill", invocation: skill[1] as "/" | "$", name: skill[2]! }); else text(words);
      return;
    }
    if (mark === "kept") {
      const place = element.getAttribute(`${MARK}-at`) ?? "";
      if (own && /^(?:0|[1-9]\d{0,5})$/.test(place) && words) add({ kind: "kept", text: words, at: Number(place), copy: own }); else text(words);
      return;
    }
    const block = BLOCK.test(element.tagName);
    if (block) line = true;
    element.childNodes.forEach(child => walk(child, own));
    if (block) line = true;
  };
  root.childNodes.forEach(child => walk(child, null));
  return pieces;
}

/** A task as it is named elsewhere: its id, a space, its title (`T11 "Working" column…`); its id alone before a title is read. */
export const taskCopy = (task: { id: string; title: string }) => task.title ? `${task.id} ${task.title}` : task.id;
/** A task as a reference: pasted here it is the task's chip, elsewhere a link to it named as `taskCopy`. */
export const taskPiece = (task: { id: string; title: string }): Piece => ({ kind: "task", address: task.id, label: taskCopy(task) });

/** A report as it is read: its title, then its Markdown body as written; either may be missing. */
export const reportCopy = (title: string, body?: string | null) =>
  [title.trim(), body?.trim()].filter(Boolean).join("\n\n");
