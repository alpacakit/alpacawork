// "done" stays recorded by the release Owner; once this page itself runs that version there is nothing left to
// load again, so it reads as no update (no mark, no line), while another page still on the old version is told to reload.
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { useUpdateStatus } from "../src/features/update/update-state";
import {UpdateCard,UpdateMark} from "../src/features/update/UpdateView";
import { APP_VERSION } from "../src/lib/app-version";
import { TestWorkspace } from "./fixtures";

beforeAll(() => startI18n());
// Each test is a page of its own: its status read from the start.
afterEach(async () => { cleanup(); vi.restoreAllMocks(); (await import("../src/data/query-client")).queryClient.clear(); });
function Kind() { return <span data-kind>{useUpdateStatus().kind}</span>; }
const serve = (version: string) => vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
  String(url).includes("update/status") ? Response.json({ kind: "done", version }) : Response.json({}));

test("done for the version this page runs reads as none", async () => {
  serve(APP_VERSION);
  const { container } = render(<TestWorkspace><Kind /></TestWorkspace>);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(container.querySelector("[data-kind]")?.textContent).toBe("none");
});

test("done for another version than this page's stays done (reload)", async () => {
  serve(`${APP_VERSION}-next`);
  const { container } = render(<TestWorkspace><Kind /></TestWorkspace>);
  await waitFor(() => expect(container.querySelector("[data-kind]")?.textContent).toBe("done"));
});

test("already stopped at the page's first read: shown as stopped at once", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url).includes("update/status")
    ? Response.json({ kind: "attention", opId: "2b0c5f1e-0a8b-4a43-9a4d-6f1d2f0b9c33", version: "0.10.0" })
    : Response.json({}));
  const { container } = render(<TestWorkspace><Kind /></TestWorkspace>);
  await waitFor(() => expect(container.querySelector("[data-kind]")?.textContent).toBe("attention"));
});

// All existing readers must hear a press's grace reset.
test("Continue on a stopped update: the gear's mark goes back to under way with the line", async()=>{
  const opId="b68c3dd3-1653-4f2e-826d-e2803d59cf49",d=(s:string)=>s.repeat(64);
  // Accepted, the release answers it as under way (its controller started before the confirm is answered).
  let status:object={kind:"attention",opId,version:"0.10.0"};
  const review={kind:"ready",candidateId:"c1",version:"0.10.0",reviewDigest:d("a"),skills:["alpacawork"],resume:{opId,candidateId:"c1",reviewDigest:d("a")}};
  let posts=0;
  vi.spyOn(globalThis,"fetch").mockImplementation(async(url,init)=>{
    if(String(url).includes("update/status"))return Response.json(status);
    if(String(url).includes("update/review"))return Response.json(review);
    if(String(url).includes("update/confirm")){posts++;status={kind:"fetching",opId,version:"0.10.0"};return Response.json({opId,terminal:null});}
    throw new Error("unexpected "+url);
  });
  const {container}=render(<TestWorkspace><UpdateMark/><UpdateCard/></TestWorkspace>);
  await waitFor(()=>expect(container.querySelector("[data-update-action]")?.textContent).toBe("Continue"));
  expect(container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("attention");
  fireEvent.click(container.querySelector("[data-update-action]")!);
  await waitFor(()=>expect(posts).toBe(1));
  await waitFor(()=>expect(container.querySelector("[data-update-action]")).toBeNull());
  expect(container.querySelector("[data-update-mark]")?.getAttribute("data-update-mark")).toBe("busy");
});
