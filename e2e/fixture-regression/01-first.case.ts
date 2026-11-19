import { test, exercise } from "./cases.ts";
test("first file", async ({ page, runtime }, info) => { await exercise({ page, runtime }, info, true); });
