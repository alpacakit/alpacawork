import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectColorField } from "../src/features/forms/ProjectColorField";
import { ProjectTile } from "../src/components/ui/project-tile";

afterEach(cleanup);

/** The field as a window holds it: what it takes is the window's colour, what the preview and the saving use. */
function Window({ onChange, submit = () => {} }: { onChange: (color: string) => void; submit?: () => void }) {
  const [color, setColor] = useState("#39659b");
  return <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <ProjectColorField name="alpacawork" value={color} onChange={(next) => { onChange(next); setColor(next); }} />
    <output data-taken>{color}</output>
  </form>;
}
const taken = () => document.querySelector("[data-taken]")!.textContent;
const preview = () => (document.querySelector("[data-project-color] [data-project-tile]") as HTMLElement).style.background;
const open = () => { fireEvent.click(document.querySelector("[data-project-color-more]")!); return document.querySelector("[data-project-color-code]") as HTMLInputElement; };
const typeInto = (field: HTMLInputElement, text: string) => { field.focus(); fireEvent.change(field, { target: { value: text } }); };

test("a colour is taken only when six digits are there, and the field keeps what was typed", () => {
  const changes = vi.fn();
  render(<Window onChange={changes} />);
  const field = open();
  const before = preview();
  for (const partial of ["1", "1b", "1b2", "1b2a", "1b2a9"]) {
    typeInto(field, partial);
    expect(field.value).toBe(partial);
    expect(taken()).toBe("#39659b");
    expect(preview()).toBe(before);
  }
  typeInto(field, "2F6A9C");
  expect(taken()).toBe("#2f6a9c");
  // The regular form went out; the field is not rewritten under the typing.
  expect(field.value).toBe("2F6A9C");
  expect(changes).toHaveBeenLastCalledWith("#2f6a9c");
});

test("three digits are taken, doubled, when the field is left or Enter is pressed, and Enter sends no form", () => {
  const submit = vi.fn();
  render(<Window onChange={() => {}} submit={submit} />);
  const field = open();
  typeInto(field, "ABC");
  expect(taken()).toBe("#39659b");
  fireEvent.blur(field);
  expect(taken()).toBe("#aabbcc");
  expect(field.value).toBe("#aabbcc");
  typeInto(field, "123");
  fireEvent.keyDown(field, { key: "Enter" });
  expect(taken()).toBe("#112233");
  expect(submit).not.toHaveBeenCalled();
  // What is no colour goes back to the colour taken.
  typeInto(field, "1b2a");
  fireEvent.blur(field);
  expect(field.value).toBe("#112233");
  expect(taken()).toBe("#112233");
});

test("a swatch is taken as it is, and the field follows it", () => {
  render(<Window onChange={() => {}} />);
  const field = open();
  fireEvent.click(screen.getAllByRole("button", { pressed: false })[0]!);
  const pressed = screen.getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true");
  expect(pressed).toHaveLength(1);
  expect(field.value).toBe(taken());
});

test("the square's letters come from the name, in white or black for its ground, with no reader text of their own", () => {
  const { rerender } = render(<ProjectTile name="alpacawork" color="#39659b" size={18} />);
  let tile = document.querySelector("[data-project-tile]") as HTMLElement;
  expect(tile.querySelector("[data-letters]")!.getAttribute("data-letters")).toBe("AL");
  expect(tile.textContent).toBe("");
  expect(tile.style.color).toBe("rgb(255, 255, 255)");
  expect(tile.getAttribute("aria-hidden")).toBe("true");
  rerender(<ProjectTile name="家計簿" color="#f2d230" size={32} label="家計簿 P275" />);
  tile = document.querySelector("[data-project-tile]") as HTMLElement;
  expect(tile.querySelector("[data-letters]")!.getAttribute("data-letters")).toBe("家");
  expect(tile.style.color).toBe("rgb(0, 0, 0)");
  expect(tile.getAttribute("aria-label")).toBe("家計簿 P275");
  const oneCharacter = tile.style.fontSize;
  // One character is drawn at one character's size, even when it takes two UTF-16 units.
  rerender(<ProjectTile name="𠮷野家" color="#39659b" size={32} />);
  tile = document.querySelector("[data-project-tile]") as HTMLElement;
  expect(tile.style.fontSize).toBe(oneCharacter);
});
