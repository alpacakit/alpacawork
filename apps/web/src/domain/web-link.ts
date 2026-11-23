import { parseTaskFileRoute } from "@alpacawork/contract/task-file-route";
import { viewerTarget } from "./viewer-target";

/**
 * Web addresses written as bare text. An address starts with http:// or https:// where a word does not go
 * on into it and an HTML attribute (`src="…"`) does not hold it, and runs over printable ASCII but for quotes,
 * angle brackets, "\" and "`": a space or any non-ASCII letter or sign (—, “, ”, é) ends it. Then, as GFM's
 * autolinks do, the sentence's own closing marks come off its end: `. , : ; ! ? ' * _ ~`, and a `)` `]` `}` that
 * closes nothing opened inside it (`(https://a.test/b)` keeps only the address; `…/Foo_(bar)` keeps its pair).
 */
const CANDIDATE = /(?<![\w/@.+-]|=["']?)https?:\/\/[!#-;=?-[\]-_a-~]+/gi;
const CLOSING = { ")": "(", "]": "[", "}": "{" } as const;

export type FoundUrl = { index: number; length: number; captured: string };

export function bareUrls(text: string): FoundUrl[] {
  const found: FoundUrl[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const url = trimEnd(match[0]);
    if (webUrl(url)) found.push({ index: match.index, length: url.length, captured: url });
  }
  return found;
}

function trimEnd(url: string): string {
  for (;;) {
    const last = url.at(-1)!;
    const opener = CLOSING[last as keyof typeof CLOSING];
    if (/[.,:;!?'*_~]/.test(last) || (opener && count(url, opener) < count(url, last))) url = url.slice(0, -1);
    else return url;
  }
}

const count = (text: string, letter: string) => {
  let total = 0;
  for (let index = text.indexOf(letter); index !== -1; index = text.indexOf(letter, index + 1)) total++;
  return total;
};

/** An http(s) address with a host; any other scheme (javascript:, data:, file:) is never a web link. */
function webUrl(href: string): URL | null {
  try {
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/**
 * Where a web address leads, as this screen sees it. An address of another origin (scheme, host and port; a trial
 * screen on another port too) leads away, to a new tab. An address of this origin stays here, in the same tab:
 * - one naming a task by its ID or address (the screen's `?task=`, a Task-folder file by the Files tab's `path`/`image`/`view`, or the server's
 *   file route) gives that task and path, to open as the task's ID or the file when the task is known;
 * - one of the screen (`/?…`) is a state the screen takes as a history step, without loading the page again;
 * - any other (an API route) is an ordinary link.
 */
type WebTarget = { kind: "away" } | { kind: "here"; task: { address: string; path: string | null } | null; screen: boolean };

export function webTarget(href: string, origin: string): WebTarget {
  const url = webUrl(href);
  if (!url || url.origin !== origin) return { kind: "away" };
  const query = url.searchParams;
  const screen = url.pathname === "/";
  const file = parseTaskFileRoute(url);
  if (file) return { kind: "here", task: { address: file.task, path: file.path }, screen };
  const address = screen ? query.get("task") : null;
  const files = query.get("tab") === "files";
  // A file read in the viewer over the Files tab is its Task's file (taskFilesLink), whichever task the tab is of.
  const read = files ? viewerTarget(query.get("view") ?? "") : null;
  if (address && read?.where === "task") return { kind: "here", screen, task: { address: read.owner, path: read.path } };
  return { kind: "here", screen,
    task: address ? { address, path: files ? query.get("image") || query.get("path") || null : null } : null };
}
