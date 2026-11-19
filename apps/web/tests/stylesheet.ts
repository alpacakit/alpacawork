import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The screen's stylesheet as text, in the order it cascades: the test lane does not load CSS (`css: false`). */
const src = join(dirname(fileURLToPath(new URL(`file://${__filename}`))), "../src");
export const stylesheet = readFileSync(join(src, "styles.css"), "utf8")
  .replace(/^@import "\.\/(.+\.css)";$/gm, (_, file: string) => readFileSync(join(src, file), "utf8"));
