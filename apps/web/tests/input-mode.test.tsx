import { expect, test } from "vitest";
import { followInput } from "../src/state/input-mode";

test("keys written into a field are not keyboard use; Tab and Escape are, as keys anywhere else are", () => {
  const root = document.documentElement;
  const field = document.createElement("div");
  field.setAttribute("contenteditable", "true");
  const button = document.createElement("button");
  document.body.append(field, button);
  const stop = followInput(document);
  try {
    root.dataset.input = "pointer";
    for (const key of ["Enter", " ", "ArrowDown"]) field.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: key === "Enter", bubbles: true }));
    expect(root.dataset.input).toBe("pointer");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root.dataset.input).toBe("keyboard");
    root.dataset.input = "pointer";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.dataset.input).toBe("keyboard");
    root.dataset.input = "pointer";
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(root.dataset.input).toBe("keyboard");
    // A text field writes too; a checkbox, a select or a range is moved by the keys.
    for (const [html, key, moved] of [["<input type=search>", " ", false], ["<textarea></textarea>", "Enter", false],
      ["<input type=checkbox>", " ", true], ["<select><option>a</option></select>", "ArrowDown", true], ["<input type=range>", "ArrowUp", true]] as const) {
      const holder = document.createElement("div"); holder.innerHTML = html; document.body.append(holder);
      root.dataset.input = "pointer";
      holder.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      expect(root.dataset.input, html).toBe(moved ? "keyboard" : "pointer");
      holder.remove();
    }
  } finally { stop(); field.remove(); button.remove(); }
});
