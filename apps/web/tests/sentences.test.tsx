import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Sentences } from "@/components/ui/sentences";

describe("Sentences", () => {
  it("sets the words marked bold in bold, inside their own sentence, whatever ends it", () => {
    const { container } = render(<p><Sentences words="This is the only box. <b>Every request goes here.</b> The coordinator receives it." /></p>);
    expect([...container.querySelectorAll("p > span")].map(sentence => sentence.textContent))
      .toEqual(["This is the only box.", "Every request goes here.", "The coordinator receives it."]);
    expect([...container.querySelectorAll("strong")].map(bold => bold.textContent)).toEqual(["Every request goes here."]);
    expect(container.textContent).not.toContain("<b>");
  });
});
