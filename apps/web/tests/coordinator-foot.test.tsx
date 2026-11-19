import { expect, test } from "vitest";
import { firstSentence } from "../src/features/coordinator/foot";

test("the folded line takes an answer's first sentence: a full-width end, or . ! ? before a space or the end", () => {
  expect(firstSentence("T134 の責任者に頼みました。原因は親の揃えです。")).toBe("T134 の責任者に頼みました。");
  expect(firstSentence("終わりました！次へ")).toBe("終わりました！");
  expect(firstSentence("Done. Next step")).toBe("Done.");
  expect(firstSentence("Version 1.2 is out")).toBe("Version 1.2 is out");
  expect(firstSentence("Is it ready?")).toBe("Is it ready?");
});

test("the folded line reads the words, not the Markdown around them", () => {
  expect(firstSentence("## まとめ\n- **T1** を見て。続き")).toBe("まとめ T1 を見て。");
  expect(firstSentence("```\npnpm build\n```\n通りました。")).toBe("通りました。");
  expect(firstSentence("[T2](https://example.com) を開いた。")).toBe("T2 を開いた。");
});
