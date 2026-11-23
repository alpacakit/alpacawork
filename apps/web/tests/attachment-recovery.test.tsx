import { beforeEach as beforeSendCase } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
beforeSendCase(allowFixtureWrites);
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { AttachButton, DraftAttachments, useAttachments } from "../src/features/reader/Attachments";
import type { AttachmentDestination } from "../src/data/attachments";
import { useDraftStore } from "../src/features/forms/draft-store";
import { useConnection } from "../src/data/connection";
import { Toaster } from "../src/components/ui/toaster";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/data/query-client';

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const key = "attachment-recovery-draft";
const opId = "upload-1";
const requestId = "request-1";
const path = `attachments/${requestId}/note.txt`;
const receipt = { path, absolutePath: `/api/tasks/T1/file?path=${encodeURIComponent(path)}`, size: 4 };
const record = { destination: `task:T1`, requestId, opId, name: "note.txt", size: 4 };
function seed(values: Record<string, string>, draft = key) {
  const entries = { [draft]: { values: { body: "", requestId, ...values }, status: "editing" as const } };
  sessionStorage.setItem("alpacawork-input-drafts-v10", JSON.stringify({ version: 6, entries }));
  useDraftStore.setState({ entries, unavailable: false });
}
type FileProps = { draft?: string; destination?: AttachmentDestination };
function Files(props: FileProps) {
  return <QueryClientProvider client={queryClient}><FileControls {...props} /></QueryClientProvider>;
}
function FileControls({ draft = key, destination = { kind: "task", taskId: "T1" } }: FileProps) {
  const attachments = useAttachments(draft, destination, false);
  return <><AttachButton attachments={attachments} /><DraftAttachments destination={destination} attachments={attachments} />
    <output data-waiting={attachments.waiting} /><Toaster />
  </>;
}
const operationReply = (state: "committed" | "pending" | "needs_review" | "not_found") =>
  new Response(JSON.stringify(state === "committed" ? { state, status: 200, body: receipt } : { state }), { status: 200 });

test("saves the upload identity before sending bytes and keeps it after a lost reply; a reloaded draft reads that operation and restores the committed attachment", async () => {
  const lostKey = `${key}-lost`;
  seed({}, lostKey);
  let sent!: XMLHttpRequest;
  class LostReply {
    upload = { onprogress: null };
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    send() {
      sent = this as unknown as XMLHttpRequest;
      const saved = JSON.parse(sessionStorage.getItem("alpacawork-input-drafts-v10")!).entries[lostKey].values;
      expect(JSON.parse(saved.uploadOps!)).toMatchObject([{ destination: `task:T1`, requestId, name: "note.txt", size: 4 }]);
    }
  }
  vi.stubGlobal("XMLHttpRequest", LostReply);
  render(<Files draft={lostKey} />);
  fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!,
    { target: { files: [new File(["note"], "note.txt")] } });
  expect(sent).toBeTruthy();
  const saved = useDraftStore.getState().entries[lostKey]!.values;
  const [upload] = JSON.parse(saved.uploadOps!);
  expect(upload.opId).toBeTruthy();
  await act(async () => { sent.onerror?.(new ProgressEvent("error")); });
  expect(useDraftStore.getState().entries[lostKey]!.values.uploadOps).toBe(saved.uploadOps);
  expect(document.querySelector('[data-attachment="note.txt"]')).toBeTruthy();
  cleanup();
  const reopenedKey = `${key}-reopened`;
  seed(saved, reopenedKey);
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(operationReply("committed"));
  render(<Files draft={reopenedKey} />);
  await waitFor(() => expect(useDraftStore.getState().entries[reopenedKey]!.values.attachments).toBeTruthy());
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(`/api/commands/operation/get?opId=${encodeURIComponent(upload.opId)}`);
  expect(JSON.parse(useDraftStore.getState().entries[reopenedKey]!.values.attachments!)).toEqual([{ ...receipt, name: "note.txt" }]);
  expect(useDraftStore.getState().entries[reopenedKey]!.values.uploadOps).toBeUndefined();
  expect(document.querySelector('[data-attachment-state="saved"]')).toBeTruthy();
  await waitFor(() => expect(document.querySelector('[data-waiting="false"]')).toBeTruthy());
});

test.each(["pending", "needs_review"] as const)("a reloaded %s upload stays unconfirmed", async state => {
  seed({ uploadOps: JSON.stringify([record]) }, `${key}-${state}`);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(operationReply(state));
  render(<Files draft={`${key}-${state}`} />);
  await waitFor(() => expect(screen.getByText(/Couldn't confirm the result/)).toBeTruthy());
  expect(document.querySelector('[data-waiting="true"]')).toBeTruthy();
  expect(useDraftStore.getState().entries[`${key}-${state}`]!.values.uploadOps).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Remove note.txt/ })).toBeNull();
});

test("a receipt for another task cannot enter the draft", async () => {
  const wrongKey = `${key}-wrong-task`;
  seed({ uploadOps: JSON.stringify([record]) }, wrongKey);
  const wrong = { ...receipt, absolutePath: `/api/tasks/T2/file?path=${encodeURIComponent(path)}` };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ state: "committed", status: 200, body: wrong })));
  render(<Files draft={wrongKey} />);
  await waitFor(() => expect(screen.getByText(/The saved attachment doesn't match the file you selected/)).toBeTruthy());
  expect(useDraftStore.getState().entries[wrongKey]!.values.attachments).toBeUndefined();
  expect(useDraftStore.getState().entries[wrongKey]!.values.uploadOps).toBeTruthy();
});

test("a missing operation asks for reselection and clears its record when dismissed", async () => {
  seed({ uploadOps: JSON.stringify([record]) }, `${key}-missing`);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(operationReply("not_found"));
  render(<Files draft={`${key}-missing`} />);
  await waitFor(() => expect(screen.getByText(/Select the file again/)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /Remove note.txt/ }));
  expect(useDraftStore.getState().entries[`${key}-missing`]!.values.uploadOps).toBeUndefined();
  expect(document.querySelector('[data-waiting="false"]')).toBeTruthy();
});


test("an interrupted receipt read uses connection recovery without another upload", async () => {
  const draft = `${key}-connection-recovery`;
  seed({ uploadOps: JSON.stringify([record]) }, draft);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("transport lost"))
    .mockResolvedValue(operationReply("committed"));
  render(<Files draft={draft} />);
  await waitFor(() => expect(log).toHaveBeenCalledWith("[attachment check]", expect.objectContaining({ code: "network_error", retry: "later" })));
  await waitFor(() => expect(document.querySelector("[data-toast]")).toBeNull());
  expect(useDraftStore.getState().entries[draft]!.values.uploadOps).toBeTruthy();
  act(() => useConnection.setState({ offline: true }));
  act(() => useConnection.setState({ offline: false }));
  await waitFor(() => expect(document.querySelector('[data-attachment-state="saved"]')).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual([`/api/commands/operation/get?opId=${opId}`, `/api/commands/operation/get?opId=${opId}`]);
  expect(useDraftStore.getState().entries[draft]!.values.uploadOps).toBeUndefined();
  expect(document.querySelector("[data-toast]")).toBeNull();
});

for (const state of ['before_restore', 'unknown_after_restore'] as const) test(`${state} stays failed until removed by hand and does not return on reload`, async () => {
  const draft = `${key}-${state}`; seed({ uploadOps: JSON.stringify([record]), body: 'keep these words' }, draft);
  const body = { state, restoreId: '1f347e6d-caba-4994-aa45-a9cf99182996', notFoundProvesUnexecuted: false,
    ...(state === 'before_restore' ? { previous: { opId, state: 'committed', status: 200, body: receipt, tasks: ['T1'] } } : {}) };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body)));
  render(<Files draft={draft} />);
  await waitFor(() => expect(screen.getByText(/Remove it with × on the attachment card/)).toBeTruthy());
  expect(document.querySelector('[data-attachment-state="failed"]')).toBeTruthy(); expect(document.querySelector('[data-waiting="true"]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Remove note.txt/ }));
  expect(useDraftStore.getState().entries[draft]!.values.body).toBe('keep these words');
  expect(useDraftStore.getState().entries[draft]!.values.uploadOps).toBeUndefined(); expect(document.querySelector('[data-waiting="false"]')).toBeTruthy();
  cleanup(); render(<Files draft={draft} />); expect(document.querySelector('[data-attachment="note.txt"]')).toBeNull();
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

test.each(['before_restore', 'unknown_after_restore'] as const)(
  '%s releases a same-file upload waiting for the old receipt without sending the old upload again', async state => {
    const draft = `${key}-queue-${state}`;
    seed({ uploadOps: JSON.stringify([record]) }, draft);
    let answer!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    const sent: XMLHttpRequest[] = [];
    class HeldUpload {
      upload = {}; open() {} setRequestHeader() {}
      send() { sent.push(this as unknown as XMLHttpRequest); }
    }
    vi.stubGlobal('XMLHttpRequest', HeldUpload);
    render(<Files draft={draft} />);
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!,
      { target: { files: [new File(['note'], 'note.txt')] } });
    expect(sent).toHaveLength(0);
    await act(async () => answer(new Response(JSON.stringify({ state,
      restoreId: '1f347e6d-caba-4994-aa45-a9cf99182996', notFoundProvesUnexecuted: false,
      ...(state === 'before_restore' ? { previous: { opId, state: 'committed', status: 200, body: receipt, tasks: ['T1'] } } : {}) }))));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(document.querySelectorAll('[data-attachment-state="failed"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-attachment-state="uploading"]')).toHaveLength(1);
    const uploads = JSON.parse(useDraftStore.getState().entries[draft]!.values.uploadOps!);
    expect(uploads).toHaveLength(2);
    expect(uploads.filter((upload: { opId: string }) => upload.opId === opId)).toHaveLength(1);
  });

test('a pending removal keeps its first click identity when clicked again after restore', async () => {
  const { receiveFullIndex } = await import('../src/data/resources');
  const draft = `${key}-frozen-removal`; seed({}, draft);
  let sent!: XMLHttpRequest;
  class HeldReply {
    upload = {}; status = 200; responseText = JSON.stringify(receipt); onload?: () => void;
    open() {} setRequestHeader() {} send() { sent = this as unknown as XMLHttpRequest; }
  }
  vi.stubGlobal('XMLHttpRequest', HeldReply);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { code: 'restore_changed', message: 'Restored', retry: 'fix', detail: { notFoundProvesUnexecuted: false } } }), { status: 409 }));
  render(<Files draft={draft} />);
  fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [new File(['note'], 'note.txt')] } });
  const before = Object.keys(sessionStorage), remove = screen.getByRole<HTMLButtonElement>('button', { name: 'Remove note.txt' });
  fireEvent.click(remove);
  const admitted = Object.keys(sessionStorage).filter(k => k.startsWith('alpacawork-write-identity:') && !before.includes(k));
  expect(admitted).toHaveLength(1);
  const index = queryClient.getQueryData<import('@alpacawork/contract/control').ProjectedIndexDTO>(['index'])!;
  act(() => receiveFullIndex(queryClient, { ...index, restoreId: '1f347e6d-caba-4994-aa45-a9cf99182996' }));
  expect(remove.disabled).toBe(false); fireEvent.click(remove);
  expect(Object.keys(sessionStorage).filter(k => k.startsWith('alpacawork-write-identity:') && !before.includes(k))).toEqual(admitted);
  await act(async () => { sent.onload?.(new ProgressEvent('load')); });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const [, request] = fetcher.mock.calls[0]!;
  expect(request?.method).toBe('POST'); expect(new Headers(request?.headers).get('X-Alpacawork-Restore-Id')).toBe('initial');
  const [, id] = JSON.parse(admitted[0]!.slice('alpacawork-write-identity:'.length));
  expect(new Headers(request?.headers).get('X-Alpacawork-Op-Id')).toBe(id);
  expect(useDraftStore.getState().entries[draft]!.values.removeOps).toBeUndefined();
});

for (const phase of ['saved', 'uploading'] as const) test(`${phase} removal admission failure is notified, releases busy, and allows a new hand retry`, async () => {
  const draft = `${key}-admission-failure-${phase}`;
  seed(phase === 'saved' ? { attachments: JSON.stringify([{ ...receipt, name: 'note.txt' }]) } : {}, draft);
  let sent!: XMLHttpRequest;
  class HeldReply {
    upload = {}; status = 200; responseText = JSON.stringify(receipt); onload?: () => void;
    open() {} setRequestHeader() {} send() { sent = this as unknown as XMLHttpRequest; }
  }
  vi.stubGlobal('XMLHttpRequest', HeldReply);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<Files draft={draft} />);
  if (phase === 'uploading') fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!,
    { target: { files: [new File(['note'], 'note.txt')] } });
  const before = Object.fromEntries(Object.keys(sessionStorage).filter(k => k.startsWith('alpacawork-write-identity:')).map(k => [k, sessionStorage.getItem(k)]));
  const set = Storage.prototype.setItem;
  let full = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (full && name.startsWith('alpacawork-write-identity:')) throw new DOMException('full', 'QuotaExceededError');
    set.call(this, name, value);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  await waitFor(() => expect(screen.getByText('Could not save the draft')).toBeTruthy());
  expect(fetcher).not.toHaveBeenCalled();
  expect(Object.fromEntries(Object.keys(sessionStorage).filter(k => k.startsWith('alpacawork-write-identity:')).map(k => [k, sessionStorage.getItem(k)]))).toEqual(before);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove note.txt' }).disabled).toBe(false);
  expect(document.querySelector('[data-attachment="note.txt"]')).toBeTruthy();
  full = false;
  fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  if (phase === 'uploading') await act(async () => { sent.onload?.(new ProgressEvent('load')); });
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST');
  await waitFor(() => expect(document.querySelector('[data-attachment="note.txt"]')).toBeNull());
});

for (const outcome of ['restore_changed', 'network_error'] as const) test(`${outcome} removal keeps evidence and only a terminal restore refusal allows the next hand operation`, async () => {
  const { receiveFullIndex } = await import('../src/data/resources');
  const draft = `${key}-terminal-${outcome}`;
  seed({ attachments: JSON.stringify([{ ...receipt, name: 'note.txt' }]) }, draft);
  const nextRestore = '1f347e6d-caba-4994-aa45-a9cf99182996';
  const refused = () => new Response(JSON.stringify({ error: { code: 'restore_changed', message: 'Restored', retry: 'fix',
    detail: { expectedRestoreId: nextRestore, receivedRestoreId: 'initial', notFoundProvesUnexecuted: false, priorResult: 'operation get' } } }), { status: 409 });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  if (outcome === 'restore_changed') fetcher.mockResolvedValueOnce(refused());
  else fetcher.mockRejectedValueOnce(new TypeError('lost reply'));
  fetcher.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<Files draft={draft} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove note.txt' }).disabled).toBe(false));
  expect(fetcher).toHaveBeenCalledTimes(1);
  const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers), oldId = firstHeaders.get('X-Alpacawork-Op-Id')!;
  const index = queryClient.getQueryData<import('@alpacawork/contract/control').ProjectedIndexDTO>(['index'])!;
  const pinKey = 'alpacawork-write-identity:' + JSON.stringify([index.root, oldId]), oldPin = sessionStorage.getItem(pinKey);
  expect(oldPin).toBe('{"restoreId":"initial"}');
  const values = useDraftStore.getState().entries[draft]!.values;
  if (outcome === 'restore_changed') {
    expect(values.removeOps).toBeUndefined();
    act(() => receiveFullIndex(queryClient, { ...index, restoreId: nextRestore }));
  } else expect(JSON.parse(values.removeOps!)[path].opId).toBe(oldId);
  fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  await waitFor(() => expect(document.querySelector('[data-attachment="note.txt"]')).toBeNull());
  expect(fetcher).toHaveBeenCalledTimes(2);
  const second = new Headers(fetcher.mock.calls[1]![1]?.headers);
  if (outcome === 'restore_changed') {
    expect(second.get('X-Alpacawork-Op-Id')).not.toBe(oldId);
    expect(second.get('X-Alpacawork-Restore-Id')).toBe(nextRestore);
  } else {
    expect(second.get('X-Alpacawork-Op-Id')).toBe(oldId);
    expect(second.get('X-Alpacawork-Restore-Id')).toBe('initial');
  }
  expect(sessionStorage.getItem(pinKey)).toBe(oldPin);
});

test('an unproven local removal never turns its guard refusal into a new operation', async () => {
  const draft = `${key}-unproven-removal`, oldId = crypto.randomUUID(), removeOps = JSON.stringify({ [path]: { requestId, opId: oldId } });
  seed({ attachments: JSON.stringify([{ ...receipt, name: 'note.txt' }]), removeOps }, draft);
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const before = Object.keys(sessionStorage).filter(k => k.startsWith('alpacawork-write-identity:'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<Files draft={draft} />);
  for (let n = 0; n < 2; n++) {
    fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove note.txt' }).disabled).toBe(false));
    expect(useDraftStore.getState().entries[draft]!.values.removeOps).toBe(removeOps);
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(Object.keys(sessionStorage).filter(k => k.startsWith('alpacawork-write-identity:'))).toEqual(before);
});

test('a restore refusal whose retirement cannot persist keeps the disk evidence and never starts a replacement itself', async () => {
  const { readDrafts } = await import('../src/features/forms/draft-store');
  const { receiveFullIndex } = await import('../src/data/resources');
  const draft = JSON.stringify(['/fixture', 'coordinator', 'retire-storage']), current = '1f347e6d-caba-4994-aa45-a9cf99182996';
  seed({ doc: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }), attachments: JSON.stringify([{ ...receipt, name: 'note.txt' }]) }, draft);
  const refused = () => new Response(JSON.stringify({ error: { code: 'restore_changed', message: 'Restored', retry: 'fix', detail: { notFoundProvesUnexecuted: false } } }), { status: 409 });
  let full = false, retained = '';
  const set = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, name, value) {
    if (full && name === 'alpacawork-input-drafts-v10') throw new DOMException('full', 'QuotaExceededError');
    set.call(this, name, value);
  });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
    retained = sessionStorage.getItem('alpacawork-input-drafts-v10')!; full = true; return refused();
  }).mockResolvedValueOnce(refused()).mockResolvedValueOnce(new Response('{}', { status: 200 }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<Files draft={draft} />); fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  await waitFor(() => expect(screen.getByText('Could not save the draft')).toBeTruthy());
  expect(fetcher).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem('alpacawork-input-drafts-v10')).toBe(retained);
  expect(useDraftStore.getState().unavailable).toBe(true);
  const oldId = new Headers(fetcher.mock.calls[0]![1]?.headers).get('X-Alpacawork-Op-Id')!, index = queryClient.getQueryData<import('@alpacawork/contract/control').ProjectedIndexDTO>(['index'])!;
  const pin = 'alpacawork-write-identity:' + JSON.stringify([index.root, oldId]), oldPin = sessionStorage.getItem(pin);
  full = false; cleanup(); act(() => { useDraftStore.setState(readDrafts()); receiveFullIndex(queryClient, { ...index, restoreId: current }); });
  render(<Files draft={draft} />); fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  await waitFor(() => expect(useDraftStore.getState().entries[draft]!.values.removeOps).toBeUndefined());
  expect(fetcher).toHaveBeenCalledTimes(2); expect(new Headers(fetcher.mock.calls[1]![1]?.headers).get('X-Alpacawork-Op-Id')).toBe(oldId);
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove note.txt' }).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Remove note.txt' }));
  await waitFor(() => expect(document.querySelector('[data-attachment="note.txt"]')).toBeNull());
  const fresh = new Headers(fetcher.mock.calls[2]![1]?.headers); expect(fresh.get('X-Alpacawork-Op-Id')).not.toBe(oldId); expect(fresh.get('X-Alpacawork-Restore-Id')).toBe(current);
  expect(sessionStorage.getItem(pin)).toBe(oldPin);
});
