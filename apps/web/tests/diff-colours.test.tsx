import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useDiffColours } from "../src/features/reader/diff/diff-colours";
import type { CodeFile, DiffColours } from "../src/features/reader/diff/diff-types";

const COLOURS = [[[0, 5, "#111", "#eee"]]] as unknown as DiffColours;
const highlightDiff = vi.fn(async () => COLOURS);
vi.mock("../src/features/reader/diff/diff-runtime", () => ({ highlightDiff }));
afterEach(cleanup);

/** What the lines are drawn with on each render, first render first. */
function Lines({ file, seen }: { file: CodeFile; seen: (colours: DiffColours | null) => void }) {
  seen(useDiffColours(file, null, true));
  return null;
}

test("a file opened again is drawn in its colours from its first frame, without asking for them again", async () => {
  const file: CodeFile = { kind: "file", path: "src/a.ts", text: "const a = 1;" };
  const first: (DiffColours | null)[] = [];
  render(<Lines file={file} seen={colours => first.push(colours)} />);
  await waitFor(() => expect(first.at(-1)).toBe(COLOURS));
  expect(first[0]).toBeNull();
  cleanup();
  const again: (DiffColours | null)[] = [];
  render(<Lines file={{ ...file }} seen={colours => again.push(colours)} />);
  expect(again[0]).toBe(COLOURS);
  expect(highlightDiff).toHaveBeenCalledTimes(1);
});
