import { readdirSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { e2eAreas, e2eOffline } from "./areas.ts";
import base from "./playwright.base.ts";

const placed = [...Object.values(e2eAreas).flat(), ...e2eOffline] as string[];
const files = readdirSync(import.meta.dirname).filter(file => file.endsWith(".check.ts")).map(file => file.slice(0, -".check.ts".length));
const wrong = [
  ...files.filter(file => !placed.includes(file)).map(file => `${file}: in no area`),
  ...placed.filter(file => !files.includes(file)).map(file => `${file}: no such file`),
  ...placed.filter((file, index) => placed.indexOf(file) !== index).map(file => `${file}: placed twice`),
];
if (wrong.length) throw new Error(`Fix e2e/areas.ts:\n${wrong.join("\n")}`);

export default defineConfig(base, {
  projects: Object.entries(e2eAreas).map(([name, area]) => ({ name, testMatch: area.map(file => `${file}.check.ts`) })),
});
