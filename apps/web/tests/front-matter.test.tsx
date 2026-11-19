import { expect, test } from "vitest";
import { frontMatter } from "../src/domain/front-matter";

const wrap = (yaml: string) => `---\n${yaml}\n---\n# Body\n`;

test("file metadata preserves order, scalar spelling, decoded strings and source", () => {
  const text = wrap('z: 007\na: "007"\nflag: TRUE\ndescription: |\n  first\n  ---\n  last\nlist: [one, two]\nnested:\n  x: yes\n  y: no');
  const r = frontMatter(text);
  expect(r.kind).toBe("parsed");
  if (r.kind !== "parsed") throw new Error("expected metadata");
  expect(r.rows.map(row => row.key)).toEqual(["z", "a", "flag", "description", "list", "nested"]);
  expect(r.rows.map(row => row.value)).toEqual(["007", "007", "TRUE", "first\n---\nlast\n", "[one, two]", "x: yes\ny: no"]);
  expect(r.raw + r.body).toBe(text);
  expect(r.body).toBe("# Body\n");
});

test("BOM, CRLF, EOF delimiters and an empty block retain original bytes", () => {
  for (const text of ["\uFEFF---\r\nname: skill\r\n---\r\nbody", "---\nname: skill\n---", "---\n---\nbody", "---\n# comment\n---\nbody"]) {
    const r = frontMatter(text);
    expect(r.kind).toBe("parsed");
    if (r.kind === "parsed") expect(r.raw + r.body).toBe(text);
  }
  expect(frontMatter("---\n---\n")).toMatchObject({ kind: "parsed", rows: [] });
});

test("ordinary Markdown, internal dividers and fenced code have no file metadata", () => {
  for (const text of ["# Title\n---\nname: x\n---", "```yaml\n---\nname: x\n---\n```", " ---\nname: x\n---", "--- \nname: x\n---"]) {
    expect(frontMatter(text)).toEqual({ kind: "none", body: text });
  }
});

test("Unicode separators inside comments and block strings are not delimiter line boundaries", () => {
  for (const separator of ["\u2028", "\u2029"]) {
    for (const yaml of [`# comment${separator}---\nname: skill`, `description: |\n  one${separator}---\n  two`]) {
      const text = wrap(yaml), r = frontMatter(text);
      expect(r).toMatchObject({ kind: "parsed", body: "# Body\n" });
      if (r.kind === "parsed") expect(r.raw + r.body).toBe(text);
    }
  }
});

test("invalid, unsupported and unclosed YAML retain all source and subsequent body", () => {
  for (const [yaml, issue] of [["name: [", "invalid"], ["x: 1\nx: 2", "invalid"], ["x: !unknown value", "unsupported"], ["- a\n- b", "unsupported"], ["ordinary words", "unsupported"], ["? [a,b]\n: value", "unsupported"], ["x: *missing", "invalid"]]) {
    const text = wrap(yaml!); const r = frontMatter(text);
    expect(r).toMatchObject({ kind: "fallback", issue, body: "# Body\n" });
    if (r.kind === "fallback") expect(r.raw + r.body).toBe(text);
  }
  const unclosed = "---\nname: skill\n# still readable\n";
  expect(frontMatter(unclosed)).toEqual({ kind: "fallback", issue: "unclosed", raw: unclosed, body: "" });
});

test("aliases and cycles are rendered as references without expansion", () => {
  const r = frontMatter(wrap('base: &base [one, two]\ncopy: *base\ncycle: &cycle [*cycle]'));
  expect(r).toMatchObject({ kind: "parsed", rows: [{ key: "base", value: "&base [one, two]" }, { key: "copy", value: "*base" }, { key: "cycle", value: "&cycle [*cycle]" }] });
});

test("scalar anchors, decoded values and empty values retain their display spelling", () => {
  const text = wrap('? &key title\n: &value "one\\ntwo"\ncopy: *value\nempty:\nexplicit: null');
  expect(frontMatter(text)).toEqual({
    kind: "parsed",
    raw: text.slice(0, -"# Body\n".length),
    body: "# Body\n",
    rows: [
      { key: "&key title", value: "&value one\ntwo" },
      { key: "copy", value: "*value" },
      { key: "empty", value: "" },
      { key: "explicit", value: "null" },
    ],
  });
});

test("large, wide and deep metadata falls back without dropping text", () => {
  for (const yaml of ['description: '+ 'x'.repeat(65_536), Array.from({length:201}, (_,i) => `k${i}: v`).join('\n'), 'nested: '+ '['.repeat(24)+'x'+']'.repeat(24), 'nodes: ['+Array(2001).fill('x').join(',')+']']) {
    const text = wrap(yaml), r = frontMatter(text);
    expect(r).toMatchObject({ kind: "fallback", issue: "limit" });
    if (r.kind === "fallback") expect(r.raw+r.body).toBe(text);
  }
});
