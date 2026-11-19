import Papa from "papaparse";
import { decodeText } from "./text-bytes";

/** Bounds for the byte transfer, retained records/cells and a single page, respectively. */
export const DELIMITED_MAX_BYTES = 2 * 1024 * 1024;
export const DELIMITED_MAX_ROWS = 1_000;
export const DELIMITED_MAX_CELLS = 20_000;
export const DELIMITED_PAGE_ROWS = 100;
type DelimitedResult = { kind: "decoded"; rows: string[][]; columns: number; truncated: boolean; malformed: boolean; uneven: boolean }
  | { kind: "encoding-error" };
export const isDelimitedFile = (name: string) => /\.(csv|tsv)$/i.test(name);

export function parseDelimited(bytes: Uint8Array, name: string): DelimitedResult {
  const text = decodeText(bytes);
  if (text === null) return { kind: "encoding-error" };
  const rows: string[][] = [];
  let cells = 0, columns = 0, truncated = false, malformed = false, uneven = false, previousCursor = -1;
  // Papa emits a synthetic empty record after a final line ending. Remove only that record;
  // real empty records (including a quoted empty cell) remain part of the file.
  const endsInNewline = /(?:\r\n|\r|\n)$/.test(text);
  if (!text) return { kind: "decoded", rows, columns, truncated, malformed, uneven };
  Papa.parse<string[]>(text, {
    delimiter: /\.tsv$/i.test(name) ? "\t" : ",", header: false, dynamicTyping: false, skipEmptyLines: false,
    step(result, parser) {
      const row = result.data;
      const cursor = result.meta.cursor;
      if (endsInNewline && cursor === previousCursor && row.length === 1 && row[0] === "" && !result.errors.length) return;
      previousCursor = cursor;
      // Bound both stored cells and the rectangular table (short rows need empty slots when drawn).
      if (rows.length >= DELIMITED_MAX_ROWS || cells + row.length > DELIMITED_MAX_CELLS
        || Math.max(columns, row.length) * (rows.length + 1) > DELIMITED_MAX_CELLS) {
        truncated = true; parser.abort(); return;
      }
      malformed ||= result.errors.length > 0;
      uneven ||= rows.length > 0 && row.length !== rows[0]!.length;
      columns = Math.max(columns, row.length);
      cells += row.length;
      rows.push(row);
    },
  });
  return { kind: "decoded", rows, columns, truncated, malformed, uneven };
}
