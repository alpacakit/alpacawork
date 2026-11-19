import { afterEach, beforeAll, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { Reader } from "../src/features/reader/Reader";
import { useViewStore } from "../src/state/view-store";
import { dto, screenData, TestWorkspace, tree } from "./fixtures";

beforeAll(() => startI18n());
afterEach(cleanup);

// A workspace that takes no writes offers no way into the input, as the input's own # does not: the head's insert
// mark cannot put a label into a draft that could never be sent.
for (const writable of [true, false]) test(`the head's insert mark is ${writable ? "offered" : "not offered"} where the workspace ${writable ? "takes" : "takes no"} writes`, () => {
  const data = screenData(tree({ writable, tasks: [dto({ id: "T11", path: "tasks/T11", title: "Build the column" })] }));
  useViewStore.setState(useViewStore.getInitialState());
  useViewStore.getState().openTask("T11", { reader: true });
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  const insert = within(document.querySelector<HTMLElement>(".reader-header")!).getByRole("button", { name: i18n.t("reader:readerHeader.insert", { id: "T11" }) });
  expect((insert as HTMLButtonElement).disabled).toBe(!writable);
});
