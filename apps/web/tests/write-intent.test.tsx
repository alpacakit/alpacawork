import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { ApiError } from "../src/data/client";
import { intentKey, readWriteIntents, useWriteIntent, useWriteIntentStore } from "../src/data/write-intent";
import { receiveFullIndex } from '../src/data/resources';
import { queryClient } from '../src/data/query-client';
import { indexOf, tree } from './fixtures';

beforeEach(() => { sessionStorage.clear(); useWriteIntentStore.setState({ entries: {}, unavailable: false }); receiveFullIndex(queryClient, { ...indexOf(tree()), root: '/root' }); });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

test("one intent retains the exact operation after an unknown answer and across a reopened input", async () => {
  const key = intentKey("/root", "report", "T1");
  const send = vi.fn().mockRejectedValueOnce(new ApiError("Lost answer")).mockResolvedValueOnce("saved");
  const first = renderHook(() => useWriteIntent<{ opId: string; title: string }, string>(key));
  await act(async () => { await expect(first.result.current.submit(id => ({ opId: id, title: "مرحبا 🌍" }), send)).rejects.toThrow(); });
  expect(first.result.current.status).toBe("unconfirmed");
  const sent = send.mock.calls[0]![0];
  first.unmount();
  const second = renderHook(() => useWriteIntent<{ opId: string; title: string }, string>(key));
  await act(async () => { await second.result.current.retrySame(send); });
  expect(send.mock.calls[1]![0]).toEqual(sent);
  expect(second.result.current.status).toBe("confirmed");
});

test("a reload turns an in-flight write into an unconfirmed write", async () => {
  const key = intentKey("/root", "approve", "T1");
  const send = vi.fn().mockImplementation(() => new Promise(() => {}));
  const hook = renderHook(() => useWriteIntent<{ opId: string }, void>(key));
  act(() => { void hook.result.current.submit(id => ({ opId: id }), send); });
  expect(hook.result.current.status).toBe("pending");
  expect(readWriteIntents().entries[key]?.status).toBe("unconfirmed");
});

test("a rejected write is editable; a conflict keeps its payload until the caller rereads", async () => {
  const key = intentKey("/root", "report", "T1");
  const hook = renderHook(() => useWriteIntent<{ opId: string; title: string }, void>(key));
  await act(async () => { await expect(hook.result.current.submit(id => ({ opId: id, title: "A" }), async () => { throw new ApiError("Conflict", "conflict", "reread"); })).rejects.toThrow(); });
  expect(hook.result.current.status).toBe("conflict");
  expect(hook.result.current.payload).toMatchObject({ title: "A" });
  act(() => hook.result.current.reset());
  expect(hook.result.current.status).toBe("editing");
});

test("a live committed ID wins over a late lost answer, and another write to the same task waits", async () => {
  const key = intentKey("/root", "request", "T1");
  const first = renderHook(() => useWriteIntent<{ opId: string }, void>(key));
  const other = renderHook(() => useWriteIntent<{ opId: string }, void>(intentKey("/root", "report", "T1")));
  let reject!: (reason: unknown) => void;
  act(() => { void first.result.current.submit(id => ({ opId: id }), () => new Promise<void>((_, fail) => { reject = fail; }))?.catch(() => {}); });
  expect(other.result.current.blocked).toBe(true);
  expect(other.result.current.submit(id => ({ opId: id }), async () => {})).toBeUndefined();
  act(() => first.result.current.confirm());
  act(() => reject(new ApiError("Lost answer")));
  expect(first.result.current.status).toBe("confirmed");
  expect(other.result.current.blocked).toBe(false);
});
