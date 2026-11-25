import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { FolderInput, newNameProblem, typedFolder } from "@/features/forms/FolderInput";
import { api } from "@/data/resources";
import { queryClient } from "@/data/query-client";
import { ApiError } from "@/data/client";
import { TestWorkspace } from "./fixtures";

beforeAll(() => startI18n());
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Field({ submit = vi.fn() }: { submit?: () => void }) {
  const [value, setValue] = useState("/code");
  return <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <FolderInput aria-label="Working folder" value={value} onChange={setValue} placeholder="/code" />
  </form>;
}
async function naming() {
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create a new folder" }));
  return screen.getByRole("textbox", { name: "New folder name" });
}
const listing = { path: "/code", parent: "/", home: "/home/me", folders: ["existing"], truncated: false };
/** This PC without a chooser to show: Choose opens the list. */
const noChooser = () => Promise.reject(new ApiError("none", "unavailable", "later"));

describe("a typed folder path", () => {
  it("is the folder written so far and the start of the next name", () => {
    expect(typedFolder("/home/me/wo")).toEqual({ folder: "/home/me/", start: "wo" });
    expect(typedFolder("/home/me/")).toEqual({ folder: "/home/me/", start: "" });
    expect(typedFolder("/")).toEqual({ folder: "/", start: "" });
    expect(typedFolder("~")).toEqual({ folder: "~/", start: "" });
    expect(typedFolder("~/co")).toEqual({ folder: "~/", start: "co" });
  });
  it("offers nothing for what is not a path", () => {
    expect(typedFolder("")).toBeNull();
    expect(typedFolder("code/web")).toBeNull();
    expect(typedFolder("~other")).toBeNull();
  });
});

describe("making a folder in the list", () => {
  it("checks names by UTF-8 bytes and spots visible duplicates after trimming", () => {
    for (const name of ["", "  "]) expect(newNameProblem(name, [])).toBe("empty");
    for (const name of ["a/b", "a\0b"]) expect(newNameProblem(name, [])).toBe("slash");
    for (const name of [".", ".."]) expect(newNameProblem(name, [])).toBe("dots");
    expect(newNameProblem("あ".repeat(86), [])).toBe("long");
    expect(newNameProblem("あ".repeat(85), [])).toBeNull();
    expect(newNameProblem(" existing ", ["existing"])).toBe("taken");
  });

  it("Enter creates once despite two presses, never submits the form, and selects the absolute path", async () => {
    let finish!: (value: { path: string }) => void;
    const result = new Promise<{ path: string }>((resolve) => { finish = resolve; });
    const request = vi.fn((url: string) => url === "/api/workspace/folders/new"
      ? result.then(value => Response.json(value)) : Promise.resolve(Response.json(listing)));
    vi.stubGlobal("fetch", request);
    const submit = vi.fn();
    render(<TestWorkspace><Field submit={submit} /></TestWorkspace>);
    const name = await naming();
    fireEvent.change(name, { target: { value: " shop " } });
    fireEvent.keyDown(name, { key: "Enter", isComposing: true });
    expect(request.mock.calls.filter(([path]) => path === "/api/workspace/folders/new")).toHaveLength(0);
    // The shared input also guards the confirming key for 50ms after composition.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(request.mock.calls.filter(([path]) => path === "/api/workspace/folders/new")).toEqual([
      ["/api/workspace/folders/new", expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/code", name: "shop" }) })],
    ]);
    await act(async () => finish({ path: "/code/shop" }));
    expect(screen.getByRole("combobox").getAttribute("value")).toBe("/code/shop");
    expect(screen.getByText("This is a newly created folder.")).toBeTruthy();
    expect(document.querySelector("[data-folder-list]")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it("Escape and × end only naming and return focus to the new-folder row", async () => {
    vi.spyOn(api, "request").mockImplementation((path) => (path === "workspace/folders/choose" ? noChooser() : Promise.resolve(listing)) as never);
    render(<TestWorkspace><Field /></TestWorkspace>);
    await naming();
    for (const cancel of [() => fireEvent.keyDown(document, { key: "Escape" }),
      () => fireEvent.click(screen.getByRole("button", { name: "Cancel new folder" }))]) {
      cancel();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Create a new folder" })));
      expect(document.querySelector("[data-folder-list]")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Create a new folder" }));
    }
  });

  it("keeps the name and the inline server refusal; a visible duplicate offers its folder", async () => {
    vi.spyOn(api, "request").mockImplementation((path) => (path === "workspace/folders/choose" ? noChooser() : path === "workspace/folders/new"
      ? Promise.reject(new ApiError("conflict", "invalid_input", "fix", undefined,
        [{ path: "name", code: "folder_exists", message: "exists" }])) : Promise.resolve(listing)) as never);
    render(<TestWorkspace><Field /></TestWorkspace>);
    const name = await naming();
    fireEvent.change(name, { target: { value: "existing" } });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Open that folder" })).toBeTruthy();
    fireEvent.change(name, { target: { value: "hidden-on-disk" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    // Clicking Create moves focus off the name on a real screen; jsdom needs that focus step explicitly.
    (screen.getByRole("combobox") as HTMLInputElement).focus();
    expect(await screen.findByText("A file or folder with this name already exists.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect((name as HTMLInputElement).value).toBe("hidden-on-disk");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector("[data-folder-list]")).toBeTruthy();
  });
});

describe("choosing on this PC", () => {
  it("takes the folder chosen in this PC's own chooser, opened at the folder written", async () => {
    const request = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(Response.json(url === "/api/workspace/folders/choose"
      ? { path: "/home/me/picked" } : listing)));
    vi.stubGlobal("fetch", request);
    render(<TestWorkspace><Field /></TestWorkspace>);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(screen.getByRole("combobox").getAttribute("value")).toBe("/home/me/picked"));
    const asked = request.mock.calls.find(([url]) => url === "/api/workspace/folders/choose")![1]!;
    expect(asked.method).toBe("POST");
    expect(JSON.parse(String(asked.body)).path).toBe("/code");
    expect(document.querySelector("[data-folder-list]")).toBeNull();
  });

  it("closes the chooser for the list on request, and opens the list where the chooser cannot be shown", async () => {
    let closed: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url !== "/api/workspace/folders/choose") return Promise.resolve(Response.json(listing));
      closed = init?.signal ?? undefined;
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }));
    render(<TestWorkspace><Field /></TestWorkspace>);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    fireEvent.click(await screen.findByRole("button", { name: "Choose here instead" }));
    expect(closed?.aborted).toBe(true);
    await waitFor(() => expect(document.querySelector("[data-folder-list]")).toBeTruthy());
    cleanup();

    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url === "/api/workspace/folders/choose"
      ? Response.json({ code: "unavailable", message: "none" }, { status: 503 }) : Response.json(listing))));
    render(<TestWorkspace><Field /></TestWorkspace>);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    await waitFor(() => expect(document.querySelector("[data-folder-list]")).toBeTruthy());
  });
});
