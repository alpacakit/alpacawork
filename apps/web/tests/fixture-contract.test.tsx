import { expect, test } from "vitest";
import { controlTaskSchema } from "@alpacawork/contract/control";
import { dto, tree } from "./fixtures";

test("screen fixtures accept flat task IDs and a separate folder path", () => {
  expect(controlTaskSchema.safeParse({ ...dto(), id: "T1/T1" }).success).toBe(false);
  expect(() => dto({ id: "T1/T1" })).toThrow();
  const parent = dto();
  const child = dto({ id: "T11", parentId: "T1", path: "tasks/T11" });
  expect(tree({ tasks: [parent, child] }).tasks[1]).toMatchObject({ id: "T11", path: "tasks/T11" });
});
