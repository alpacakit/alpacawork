import { test, exercise } from "./cases.ts";
test("second file", async ({ page, runtime }, info) => { await exercise({ page, runtime }, info, false); });
