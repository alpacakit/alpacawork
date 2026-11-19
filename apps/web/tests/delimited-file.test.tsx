import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createApi, FileReadLimitError, ApiError } from "../src/data/client";
import { parseDelimited, DELIMITED_MAX_ROWS, DELIMITED_MAX_CELLS } from "../src/domain/delimited-file";

const read = (text: string, name = "sample.csv") => {
  const result = parseDelimited(new TextEncoder().encode(text), name);
  if (result.kind !== "decoded") throw new Error("Unexpected decode failure");
  return result;
};
beforeEach(() => vi.stubGlobal("ReadableStream", NodeReadableStream));
afterEach(() => vi.unstubAllGlobals());

test("the file's delimiter and string values preserve quotes, newlines, zeroes and blank records", () => {
  expect(read('id,note,\r\n001,"one\r\ntwo, ""quoted""",\r\n\r\n').rows)
    .toEqual([["id", "note", ""], ["001", 'one\r\ntwo, "quoted"', ""], [""]]);
  expect(read('a\tb\n01\t"x\ty"\n', "UPPER.TSV").rows).toEqual([["a", "b"], ["01", "x\ty"]]);
  expect(read('\n').rows).toEqual([[""]]);
  expect(read('""\n\n').rows).toEqual([[""], [""]]);
  expect(read('').rows).toEqual([]);
  expect(read('""').rows).toEqual([[""]]);
  expect(read('\ufeffa,a,\n1,2,3').rows[0]).toEqual(["a", "a", ""]);
});

test("the bytes select UTF-8 first, including BOM and text also valid as Shift_JIS", () => {
  expect(read("名前,記号\n山田,😀").rows).toEqual([["名前", "記号"], ["山田", "😀"]]);
  // C2 A2 is valid in both encodings; UTF-8 wins, so this is one cent sign, not two half-width characters.
  expect(parseDelimited(new Uint8Array([0xc2, 0xa2]), "a.csv")).toMatchObject({ kind: "decoded", rows: [["¢"]] });
  expect(read("\ufeff名前,番号\n山田,007").rows).toEqual([["名前", "番号"], ["山田", "007"]]);
});

test("invalid UTF-8 selects strict Shift_JIS automatically, keeping the delimiter and values", () => {
  const bytes = new Uint8Array([0x96, 0xbc, 0x91, 0x4f, 0x2c, 0x30, 0x31]); // 名前,01
  expect(parseDelimited(bytes, "a.csv")).toMatchObject({ kind: "decoded", rows: [["名前", "01"]] });
  bytes[4] = 0x09;
  expect(parseDelimited(bytes, "a.tsv")).toMatchObject({ kind: "decoded", rows: [["名前", "01"]] });
});

test("unreadable bytes and a broken UTF-8 file marked by its BOM never become replacement text or another encoding", () => {
  expect(parseDelimited(new Uint8Array([0x81]), "a.csv")).toEqual({ kind: "encoding-error" });
  // The BOM declares UTF-8. Its invalid body must not be reinterpreted as a valid Shift_JIS file.
  expect(parseDelimited(new Uint8Array([0xef, 0xbb, 0xbf, 0x96, 0xbc]), "a.csv")).toEqual({ kind: "encoding-error" });
});

test("uneven and malformed records remain readable with explicit diagnostics", () => {
  expect(read('a,b\n1\n2,3,4')).toMatchObject({ rows: [["a", "b"], ["1"], ["2", "3", "4"]], columns: 3, uneven: true, malformed: false });
  expect(read('a,b\n"unterminated')).toMatchObject({ malformed: true });
});

test("row and cell bounds stop parsing, and an exact bound with a final newline is complete", () => {
  const exact = Array.from({ length: DELIMITED_MAX_ROWS }, (_, i) => String(i)).join("\n") + "\n";
  expect(read(exact)).toMatchObject({ truncated: false });
  expect(read(exact).rows).toHaveLength(DELIMITED_MAX_ROWS);
  expect(read(exact + "extra")).toMatchObject({ truncated: true });
  const many = Array.from({ length: DELIMITED_MAX_CELLS + 1 }, () => "x").join(",");
  expect(read(many)).toMatchObject({ rows: [], truncated: true });
  const sparse = read('a\n'.repeat(999) + Array.from({ length: 1000 }, () => "b").join(","));
  expect(sparse.truncated).toBe(true);
  expect(sparse.rows.length * sparse.columns).toBeLessThanOrEqual(DELIMITED_MAX_CELLS);
});

test("bounded byte reads preserve bytes and reject declared and streamed overflow with cancellation", async () => {
  const api = createApi();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0x96, 0xbc]))));
  expect(await api.requestBytes("/file", 2)).toEqual(new Uint8Array([0x96, 0xbc]));
  for (const declared of [false, true]) {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); }, cancel,
    }), { headers: declared ? { "content-length": "3" } : undefined })));
    await expect(api.requestBytes("/file", 2)).rejects.toBeInstanceOf(FileReadLimitError);
    expect(cancel).toHaveBeenCalledOnce();
  }
});

test("the byte adapter uses the common HTTP refusal and reports interrupted bodies", async () => {
  const api = createApi();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 403 })));
  await expect(api.requestBytes("/file", 2)).rejects.toMatchObject({ code: "forbidden", retry: "later" });
  const cause = new Error("broken stream");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(c) { c.error(cause); } }))));
  await expect(api.requestBytes("/file", 2)).rejects.toMatchObject({ cause, code: "invalid_response" });
  try { await api.requestBytes("/file", 2); } catch (error) { expect(error).toBeInstanceOf(ApiError); }
});
