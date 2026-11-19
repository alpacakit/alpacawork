import { describe, expect, it } from "vitest";
import { sizeText, splitAttachments } from "@/domain/attachments";

const folder = "/api/tasks/T1/file?path=";
const shot = { name: "shot.png", path: "attachments/0a1b2c3d/shot.png", absolutePath: `${folder}attachments%2F0a1b2c3d%2Fshot.png`, size: 10 };
const notes = { name: "notes.txt", path: "attachments/4e5f6a7b/notes.txt", absolutePath: `${folder}attachments%2F4e5f6a7b%2Fnotes.txt`, size: 4 };

describe("attachments in an instruction", () => {
  it("reads back the files the task's own attachments folder holds, and leaves anything else in the words", () => {
    const body = `Review\n[External](/elsewhere/a.txt)\n\n![shot.png](${shot.absolutePath})\n[notes.txt](${notes.absolutePath})`;
    expect(splitAttachments(body, folder)).toEqual({ words: "Review\n[External](/elsewhere/a.txt)",
      files: [{ name: "shot.png", path: shot.path, media: true }, { name: "notes.txt", path: notes.path, media: false }] });
    expect(splitAttachments(body, "/api/tasks/T2/file?path=").files).toEqual([]);
    expect(splitAttachments(`[a](${folder}files%2Fa.txt)`, folder)).toEqual({ words: `[a](${folder}files%2Fa.txt)`, files: [] });
  });
  it("reads a file whose URL also names its project, as the server writes it", () => {
    const named = "/api/tasks/T1/file?path=attachments%2F0a1b2c3d%2Fshot.png";
    expect(splitAttachments(`Review\n\n![shot.png](${named})`, folder)).toEqual({ words: "Review",
      files: [{ name: "shot.png", path: shot.path, media: true }] });
  });
  it("reads only a contiguous attachment suffix, preserving line boundaries", () => {
    const links = `  ![shot.png](${shot.absolutePath}) \r\n[notes.txt](${notes.absolutePath})\r`;
    const files = [{ name: "shot.png", path: shot.path, media: true }, { name: "notes.txt", path: notes.path, media: false }];
    expect(splitAttachments(`  Review\r\n\r\n${links}`, folder)).toEqual({ words: "Review", files });
    expect(splitAttachments(links, folder)).toEqual({ words: "", files });
    for (const suffix of ["\n", "\r\n", "\n  "]) {
      const body = `Review\n${links}${suffix}`;
      expect(splitAttachments(body, folder)).toEqual({ words: body.trim(), files: [] });
    }
  });
});

it("uses the file size abbreviations and the screen language's decimal separator", () => {
  for (const locale of ["en", "ja"]) {
    expect(sizeText(820, locale)).toBe("820 B");
    expect(sizeText(14 * 1024, locale)).toBe("14 KB");
    expect(sizeText(3.2 * 1024 ** 2, locale)).toBe("3.2 MB");
  }
  expect(sizeText(3.2 * 1024 ** 2, "es")).toBe("3,2 MB");
});
