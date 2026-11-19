import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useReadIds, useTasks, useWorkspaceInfo } from "../src/data/queries";
import { createWorkspaceStore, publishWorkspace, WorkspaceContext } from "../src/data/workspace-store";
import { screenData } from "./fixtures";

describe("workspace selectors", () => {
  it("does not redraw readers of unchanged values when one task changes", () => {
    const data = screenData();
    const store = createWorkspaceStore(data);
    const renders = { root: 0, tasks: 0, reads: 0 };
    function Root() { useWorkspaceInfo((info) => info.root); renders.root++; return null; }
    function Tasks() { useTasks(); renders.tasks++; return null; }
    function Reads() { useReadIds(); renders.reads++; return null; }
    render(<WorkspaceContext value={store}><Root /><Tasks /><Reads /></WorkspaceContext>);

    act(() => publishWorkspace(store, { ...data,
      tasks: data.tasks.map((task) => ({ ...task, title: "Updated" })),
      readIds: new Set(data.readIds), info: { ...data.info },
    }));
    expect(renders).toEqual({ root: 1, tasks: 2, reads: 1 });

    const current = store.getState();
    act(() => publishWorkspace(store, { ...current, tasks: [...current.tasks], shelved: [...current.shelved] }));
    expect(renders).toEqual({ root: 1, tasks: 2, reads: 1 });
  });
});
