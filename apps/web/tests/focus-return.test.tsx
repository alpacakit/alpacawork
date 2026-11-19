import { afterEach, describe, expect, it } from "vitest";
import { giveFocusBack, openerChain, rememberOpener } from "@/lib/focus-return";

afterEach(() => { document.body.replaceChildren(); });
const button = (parent: Element, name: string) => { const b = document.createElement("button"); b.textContent = name; parent.append(b); return b; };

describe("focus back when a surface closes", () => {
  it("goes to the opener of the surface an opener stood in, once that opener is gone", () => {
    const more = button(document.body, "⋯");
    const menu = document.createElement("div"); document.body.append(menu);
    rememberOpener(menu, [more]);
    const item = button(menu, "Mark as stopped"); item.focus();
    const chain = openerChain(document.activeElement);
    expect(chain).toEqual([item, more]);
    menu.remove();
    giveFocusBack(chain);
    expect(document.activeElement).toBe(more);
  });

  it("reads the last focused element's chain when the press took that element away before the surface read it", () => {
    const more = button(document.body, "⋯");
    const menu = document.createElement("div"); document.body.append(menu);
    rememberOpener(menu, [more]);
    const item = button(menu, "Mark as stopped"); item.focus();
    menu.remove();
    expect(document.activeElement).toBe(document.body);
    expect(openerChain(document.activeElement)).toEqual([item, more]);
  });

  it("leaves the focus where something opened since has it", () => {
    const more = button(document.body, "⋯"), other = button(document.body, "Others");
    other.focus();
    giveFocusBack([more]);
    expect(document.activeElement).toBe(other);
  });

  it("keeps the first opener through surfaces that went one after another", () => {
    const more = button(document.body, "⋯");
    const menu = document.createElement("div"); document.body.append(menu); rememberOpener(menu, [more]);
    const item = button(menu, "Mark as stopped"); item.focus(); menu.remove(); menu.replaceChildren();
    const form = document.createElement("div"); document.body.append(form); rememberOpener(form, openerChain(document.activeElement));
    const next = button(form, "Next"); next.focus();
    const chain = openerChain(document.activeElement);
    form.remove(); form.replaceChildren();
    giveFocusBack(chain);
    expect(document.activeElement).toBe(more);
  });

  it("passes over an opener that cannot take the focus", () => {
    const ancestor = button(document.body, "⋯"), opener = button(document.body, "Unavailable");
    opener.disabled = true;
    giveFocusBack([opener, ancestor]);
    expect(document.activeElement).toBe(ancestor);
  });

  it("keeps each document's focus apart (a picture-in-picture window's)", () => {
    const frame = document.createElement("iframe"); document.body.append(frame);
    const at = frame.contentDocument!;
    const target = at.createElement("button"); at.body.append(target);
    giveFocusBack([target]);
    expect(at.activeElement).toBe(target);
    const main = button(document.body, "main"); main.focus(); main.remove();
    expect(openerChain(at.body)).toEqual([]);
  });

  // What an open modal covers is read as covered (Radix sets aria-hidden on the rest of the page).
  it("passes over an opener under a modal still open, and gives the focus to that modal's title when none is left", () => {
    const gear = button(document.body, "gear"); gear.setAttribute("aria-hidden", "true");
    const modal = document.createElement("div"); modal.dataset.slot = "dialog-content"; document.body.append(modal);
    const title = document.createElement("h2"); title.dataset.slot = "dialog-title"; title.tabIndex = -1; modal.append(title);
    const gone = button(modal, "update"); gone.remove();
    giveFocusBack([gone, gear]);
    expect(document.activeElement).toBe(title);
  });

  it("gives the focus back to an opener inside the open modal (a popup closed there)", () => {
    const covered = document.createElement("div"); covered.setAttribute("aria-hidden", "true"); document.body.append(covered);
    const lower = document.createElement("div"); lower.dataset.slot = "dialog-content"; covered.append(lower);
    const modal = document.createElement("div"); modal.dataset.slot = "dialog-content"; document.body.append(modal);
    const opener = button(modal, "menu");
    giveFocusBack([opener]);
    expect(document.activeElement).toBe(opener);
  });

  it("with no modal open and no opener left, leaves the focus where it is", () => {
    const gone = button(document.body, "gone"); gone.remove();
    giveFocusBack([gone]);
    expect(document.activeElement).toBe(document.body);
  });
});
