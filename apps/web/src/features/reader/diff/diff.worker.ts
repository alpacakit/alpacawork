import { attachResolvedLanguages, attachResolvedThemes, DiffHunksRenderer, getSharedHighlighter, parsePatchFiles } from "@pierre/diffs";
import { normalizeTheme } from "shiki/core";
import { colour, coloursFromAST, planDiff } from "./diff-policy";
import { acceptsDiffInput, DIFF_LIMITS } from "@alpacawork/contract/report-diff";
import { codeLanguage, type CodeLanguage } from "./diff-languages";
import type { CodeFile, DiffColours, DiffSpan, StructuredDiffDocument, DiffWorkerRequest, DiffWorkerResponse } from "./diff-types";

// Local worker boundary avoids adding the WebWorker lib to the application's DOM globals.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DiffWorkerRequest>) => void) | null;
  postMessage(message: DiffWorkerResponse): void;
};
const active = new Set<number>();
/** The only bound on a failure's cause: the response's schema takes any string. One render's cause, and how many a response says. */
const CAUSE_UNITS = 1024, RENDER_CAUSES = 3;
const bounded = (cause: string) => cause.slice(0, CAUSE_UNITS);
const theme = { light: "github-light-high-contrast", dark: "github-dark-default" };
let highlighter: ReturnType<typeof initialise> | undefined;
async function initialise() {
  const instance = await getSharedHighlighter({ themes: [], langs: [], preferredHighlighter: "shiki-js" });
  const themes = await Promise.all([import("shiki/themes/github-light-high-contrast.mjs"), import("shiki/themes/github-dark-default.mjs")]);
  attachResolvedThemes(themes.map(module => {
    const normalized = normalizeTheme(module.default);
    return { name: normalized.name, type: normalized.type, fg: normalized.fg, bg: normalized.bg,
      colors: normalized.colors, textmate: normalized };
  }), instance);
  return instance;
}
async function language(instance: Awaited<ReturnType<typeof initialise>>, language: CodeLanguage) {
  if (!instance.hasLoadedLanguages([language.id])) {
    const grammar = await language.import();
    attachResolvedLanguages([{ name: language.id, data: grammar.default }], instance);
  }
}

scope.onmessage = ({ data }) => {
  if (data.kind === "cancel") { active.delete(data.id); return; }
  active.add(data.id);
  void highlight(data.id, data.document).catch(error => {
    if (active.has(data.id)) scope.postMessage({ id: data.id, colours: null, reason: "highlight-failed", cause: bounded(String(error)) });
  }).finally(() => active.delete(data.id));
};
async function highlight(id: number, document: StructuredDiffDocument | CodeFile): Promise<void> {
  const { text } = document;
  if (!acceptsDiffInput(text)) { scope.postMessage({ id, colours: null }); return; }
  if (document.kind === "file") { await paintFile(id, document); return; }
  // Unsupported/vendor-inconsistent input disables syntax only; the main-thread structure survives.
  let files;
  try { files = parsePatchFiles(text, undefined, true).flatMap(patch => patch.files); }
  catch { scope.postMessage({ id, colours: null }); return; }
  const plans = planDiff(document, files);
  if (!plans.length) { scope.postMessage({ id, colours: null }); return; }
  const instance = await (highlighter ??= initialise());
  const colours: DiffColours = Array.from({ length: document.lines.length }, () => null);
  // One bounded cause per failed language per request.
  const failures = new Map<CodeLanguage, string>();
  const renderFailures: string[] = [];
  for (const plan of plans) {
    if (!active.has(id)) return;
    if (failures.has(plan.language)) continue;
    try {
      await language(instance, plan.language);
    } catch (error) {
      failures.set(plan.language, bounded(`${plan.language.id}: ${String(error)}`));
      continue;
    }
    if (!active.has(id)) return;
    try {
      // Publish a file atomically: a failed render/source check must leave all its rows null.
      const fileColours: DiffColours = Array.from({ length: colours.length }, () => null);
      const renderer = new DiffHunksRenderer({ theme, preferredHighlighter: "shiki-js", diffStyle: "unified",
        disableFileHeader: true, lineDiffType: "char", tokenizeMaxLineLength: DIFF_LIMITS.lineUnits + 1 });
      try {
        const result = await renderer.asyncRender(plan.file);
        if (active.has(id)) coloursFromAST(plan, result, fileColours);
      } finally {
        renderer.cleanUp();
      }
      if (active.has(id)) fileColours.forEach((row, index) => { if (row) colours[index] = row; });
    } catch (error) {
      if (renderFailures.length < RENDER_CAUSES) renderFailures.push(bounded(String(error)));
    }
  }
  if (active.has(id)) scope.postMessage({ id, colours: colours.some(Boolean) ? colours : null,
    ...(failures.size || renderFailures.length ? { reason: renderFailures.length ? "highlight-failed" as const : "grammar-load" as const,
      cause: [...failures.values(), ...renderFailures].join("; ").slice(0, CAUSE_UNITS * RENDER_CAUSES) } : {}) });
}

/**
 * The most lines a whole file is painted with: its colours land at once, and drawing them holds the page about 0.05 ms a
 * line on a quick PC (4× that on a slow one), so a longer file stays plain rather than stop the reader for a moment.
 */
const FILE_LINES = 2000;
/** A whole file's lines, each its tokens' colours from its first letter; a line whose tokens do not spell it stays plain. */
async function paintFile(id: number, { path, text }: CodeFile): Promise<void> {
  const code = codeLanguage(path);
  const lines = text.split("\n");
  if (!code || lines.length > FILE_LINES + 1) { scope.postMessage({ id, colours: null }); return; }
  const instance = await (highlighter ??= initialise());
  try {
    await language(instance, code);
  } catch (error) {
    if (active.has(id)) scope.postMessage({ id, colours: null, reason: "grammar-load", cause: bounded(`${code.id}: ${String(error)}`) });
    return;
  }
  if (!active.has(id)) return;
  const { tokens } = instance.codeToTokens(text, { lang: code.id, themes: theme, defaultColor: false, cssVariablePrefix: "--c-",
    tokenizeMaxLineLength: DIFF_LIMITS.lineUnits + 1 });
  const colours: DiffColours = tokens.map((line, at) => {
    const spans: DiffSpan[] = [];
    let end = 0;
    for (const token of line) {
      const start = end, light = token.htmlStyle?.["--c-light"], dark = token.htmlStyle?.["--c-dark"];
      end += token.content.length;
      if (token.content && light && dark && colour.test(light) && colour.test(dark)) spans.push([start, end, light, dark]);
    }
    return line.map(token => token.content).join("") === lines[at]?.replace(/\r$/, "") ? spans : null;
  });
  if (active.has(id)) scope.postMessage({ id, colours: colours.some(row => row?.length) ? colours : null });
}
