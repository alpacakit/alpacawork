import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePrefetch } from "../src/data/prefetch";
import { readScheduler, startReadScheduler } from "../src/data/read-scheduler";
import { Loadable } from "../src/components/ui/loadable";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

test("a passing hover asks nothing; a held hover and touch ask the read scheduler for the Task", async () => {
  vi.useFakeTimers();
  const client = new QueryClient();
  const stop = startReadScheduler(client);
  const prefetch = vi.spyOn(readScheduler(client)!, "pointed");
  function Probe() {
    const handlers = usePrefetch("T1");
    return <button {...handlers}>Open</button>;
  }
  render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  const button = screen.getByRole("button", { name: "Open" });
  fireEvent.pointerEnter(button, { pointerType: "mouse" });
  await act(async () => vi.advanceTimersByTimeAsync(99));
  fireEvent.pointerLeave(button, { pointerType: "mouse" });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(prefetch).not.toHaveBeenCalled();
  fireEvent.pointerEnter(button, { pointerType: "pen" });
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(prefetch).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(button, { pointerType: "touch" });
  expect(prefetch).toHaveBeenCalledTimes(2);
  expect(prefetch).toHaveBeenLastCalledWith("T1");
  stop(); client.clear();
});

test("initial skeleton waits 150ms and gives way the moment the data arrives", async () => {
  vi.useFakeTimers();
  const pending = { data: undefined as string | undefined, isPending: true, isError: false,
    isFetching: true, error: null, refetch: vi.fn() };
  const view = (query: typeof pending) => <Loadable query={query} skeleton={<span>Loading rows</span>}
    empty={<span>Empty</span>}>{data => <span>{data}</span>}</Loadable>;
  const mounted = render(view(pending));
  await act(async () => vi.advanceTimersByTimeAsync(149));
  expect(screen.queryByText("Loading rows")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByText("Loading rows")).toBeTruthy();
  mounted.rerender(view({ ...pending, data: "Ready", isPending: false, isFetching: false }));
  expect(screen.getByText("Ready")).toBeTruthy();
  expect(screen.queryByText("Loading rows")).toBeNull();
  // Waiting again (another task's read) starts the 150ms afresh, not from the skeleton already shown.
  mounted.rerender(view(pending));
  expect(screen.queryByText("Loading rows")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(150));
  expect(screen.getByText("Loading rows")).toBeTruthy();
});
