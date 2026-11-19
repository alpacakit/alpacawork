import { palette } from "./mermaid-palette";
import { beforeEach, expect, test, vi } from "vitest";
const api = { initialize: vi.fn(), parse: vi.fn(), render: vi.fn() };
beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(api)) mock.mockReset();
  api.parse.mockResolvedValue({ diagramType: "flowchart" });
  api.render.mockImplementation(async (id: string) => ({ svg: `<svg id="${id}"/>` }));
  vi.doMock("mermaid", () => ({ default: api }));
});

test("the isolated runtime initializes each render with strict, non-HTML labels and the parent's font", async () => {
  const { renderMermaidSvg } = await import("../src/lib/mermaid-renderer");
  expect((await renderMermaidSvg("A", { ...palette("light"), fontFamily: '"Yu Gothic UI", sans-serif' })).ok).toBe(true);
  expect((await renderMermaidSvg("A", { ...palette("dark"), fontFamily: '"Yu Gothic UI", sans-serif' })).ok).toBe(true);
  expect(api.initialize).toHaveBeenCalledTimes(2);
  expect(api.initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: "strict", htmlLabels: false,
    fontFamily: '"Yu Gothic UI", sans-serif', look: "classic", flowchart: { htmlLabels: false, wrappingWidth: 280, minNodeWidth: 0 },
    themeVariables: expect.objectContaining({ dropShadow: "none", pieOpacity: 1 }),
    secure: expect.arrayContaining(["secure", "securityLevel", "htmlLabels", "flowchart", "themeCSS", "theme", "themeVariables", "darkMode", "look", "dropShadow"]) }));
  expect(api.parse.mock.calls[1]![0]).toBe("A");
  expect(api.initialize.mock.calls[1]![0]).toMatchObject({ theme: "base", darkMode: true, themeVariables: { darkMode: true, primaryColor: palette("dark").node, textColor: palette("dark").ink } });
  expect(document.body.style.fontFamily).toBe('"Yu Gothic UI", sans-serif');
});

test("responsive SVG preserves intrinsic dimensions for the reader and slider", async () => {
  api.render.mockResolvedValueOnce({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 687 191" />' });
  const { renderMermaidSvg } = await import("../src/lib/mermaid-renderer");
  const result = await renderMermaidSvg("A", palette("light"));
  expect(result).toMatchObject({ ok: true, width: 687, height: 191, svg: expect.stringContaining('width="687"') });
  expect(result).toMatchObject({ svg: expect.stringContaining(`color:${palette("light").muted}`) });
});

test("CSP violations fail generically without interpreting any diagram-specific source or DB", async () => {
  api.render.mockImplementationOnce(async () => {
    const violation = new Event("securitypolicyviolation");
    Object.defineProperty(violation, "effectiveDirective", { value: "img-src" });
    document.dispatchEvent(violation);
    return { svg: "<svg/>" };
  });
  const { renderMermaidSvg } = await import("../src/lib/mermaid-renderer");
  expect(await renderMermaidSvg("any future diagram syntax", palette("light")))
    .toEqual({ ok: false, reason: "Diagram resource blocked by CSP (img-src)" });
  expect((await renderMermaidSvg("next source", palette("light"))).ok).toBe(true);
  expect(document.querySelector("[data-mermaid-render]")).toBeNull();
});

test("parse failure skips rendering and render failure cleans every temporary element", async () => {
  api.parse.mockRejectedValueOnce(new Error("Parse error"));
  const { renderMermaidSvg } = await import("../src/lib/mermaid-renderer");
  expect(await renderMermaidSvg("bad", palette("light"))).toEqual({ ok: false, reason: "Parse error" });
  expect(api.render).not.toHaveBeenCalled();
  api.render.mockImplementationOnce(async (id: string) => {
    for (const name of [id, `d${id}`, `i${id}`]) { const item = document.createElement("div"); item.id = name; document.body.append(item); }
    throw new Error("Layout failed");
  });
  expect(await renderMermaidSvg("valid", palette("light"))).toEqual({ ok: false, reason: "Layout failed" });
  expect(document.querySelector('[data-mermaid-render], [id*="alpacawork-mermaid-"]')).toBeNull();
});

test("a dynamic import failure preserves a displayable reason", async () => {
  vi.doMock("mermaid", () => { throw new Error("Chunk could not be loaded"); });
  const { renderMermaidSvg } = await import("../src/lib/mermaid-renderer");
  expect(await renderMermaidSvg("A", palette("light"))).toMatchObject({ ok: false, reason: expect.any(String) });
});
