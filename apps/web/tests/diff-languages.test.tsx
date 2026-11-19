import { expect, it } from "vitest";
import { codeLanguage } from "../src/features/reader/diff/diff-languages";

it.each([
  ["src/a.ts", "typescript"], ["types.d.ts", "typescript"], ["App.tsx", "tsx"], ["README.MD", "markdown"], ["ci.yml", "yaml"],
  ["run.mjs", "javascript"], ["main.py", "python"], ["lib.rs", "rust"], ["x.h", "c"], ["x.cc", "cpp"], ["page.htm", "html"],
  ["Dockerfile", "docker"], ["app/Makefile", "make"], [".env", "dotenv"], [".eslintrc.json", "json"], ["build.sh", "shellscript"],
])("%s is painted as %s", (path, id) => expect(codeLanguage(path)?.id).toBe(id));

it.each(["notes.txt", "README", ".gitignore", "a.zzz", "file.constructor", "dir.ts/README", ""])("%s stays plain", path =>
  expect(codeLanguage(path)).toBeNull());
