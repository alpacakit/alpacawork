import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { waitFor } from "@testing-library/react";
import { useConversation } from "@/features/coordinator/coordinator";
import { screenData } from './fixtures';
import { sharedName, sharedText } from "@/features/coordinator/shared";

// Taking a share opens the actual composer. Its conversation read is part of this fixture too.
const conversation = { id: 'share-inbox', nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [], turns: [] };
let reads: MockInstance<typeof fetch>;
beforeEach(() => {
  screenData();
  setConversationState(useConversation.getInitialState());
  reads = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    expect(String(url)).toBe('/api/coordinator');
    return new Response(snapshotJson(conversation));
  });
});
afterEach(async () => {
  if (reads.mock.calls.length) await waitFor(() => expect(useConversation.getState().conversation?.id).toBe(conversation.id));
  setConversationState(useConversation.getInitialState());
});

describe("the words that come with a share", () => {
  it("keeps each of title, text and link on its own line", () => {
    expect(sharedText("Screenshot", "Look at this screen", "https://example.com/a")).toBe("Screenshot\nLook at this screen\nhttps://example.com/a");
  });
  it("drops a repeated line, a link the text already holds, and empty ones", () => {
    expect(sharedText("Article", "Article https://example.com/a", "https://example.com/a")).toBe("Article\nArticle https://example.com/a");
    expect(sharedText("Photo", "Photos from the trip", "")).toBe("Photo\nPhotos from the trip");
    expect(sharedText("", " ", "")).toBe("");
    expect(sharedText("Same", "Same", "")).toBe("Same");
  });
});

describe("the name of a shared file", () => {
  it("keeps a name that says its kind", () => {
    expect(sharedName("Screenshot_20261015.png", "image/png")).toBe("Screenshot_20261015.png");
    expect(sharedName("notes.txt", "text/plain")).toBe("notes.txt");
    expect(sharedName("anim.gif", "image/gif")).toBe("anim.gif");
  });
  it("adds the kind from the type when the name lacks it", () => {
    expect(sharedName("IMG_0001", "image/jpeg")).toBe("IMG_0001.jpg");
    expect(sharedName("", "image/png")).toBe("image.png");
    expect(sharedName("document", "application/pdf")).toBe("document.pdf");
    expect(sharedName("VID_0001", "video/quicktime")).toBe("VID_0001.mov");
    expect(sharedName("", "audio/mpeg")).toBe("file.mp3");
    expect(sharedName("report", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("report.docx");
    expect(sharedName("report", "application/msword")).toBe("report.doc");
  });
  it("leaves a name as it is when the type does not say a kind", () => {
    expect(sharedName("data", "application/octet-stream")).toBe("data");
    expect(sharedName("report", "application/vnd.ms-outlook")).toBe("report");
    expect(sharedName("blob", "")).toBe("blob");
  });
});

describe('durable share inbox receipts', () => {
  it('reading twice preserves words and bytes; acknowledgement cannot delete a later share', async () => {
    const { vi } = await import('vitest');
    const { takeShared, acknowledgeShared, useShared } = await import('@/features/coordinator/shared');
    const { useConversation } = await import('@/features/coordinator/coordinator');
    const rows = new Map<string, Response>();
    let present = true;
    const manifest = (text: string) => new Response(snapshotJson({ at: Date.now(), title: '', text, url: '', files: [{ name: 'shared.txt', type: 'text/plain', size: 12 }] }));
    rows.set('/share/list', manifest('Keep the text')); rows.set('/share/0', new Response('shared bytes'));
    vi.stubGlobal('File', (await import('node:buffer')).File);
    vi.stubGlobal('caches', { has: async () => present, open: async () => ({ match: async (key: string) => rows.get(key)?.clone(), put: async (key: string, response: Response) => { rows.set(key, response); } }), delete: async () => { present = false; return true; } });
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_: string, action: () => unknown) => action() } });
    try {
      await takeShared(); const first = useShared.getState().shared!;
      expect(first.text).toBe('Keep the text'); expect(first.files[0]!.size).toBe(12); expect(await (first.files[0] as File).text()).toBe('shared bytes'); expect(present).toBe(true);
      useShared.setState({ shared: null });
      await takeShared(); const reread = useShared.getState().shared!;
      expect(reread.id).toBe(first.id); expect(reread.files[0]!.size).toBe(12); expect(present).toBe(true);
      rows.set('/share/list', manifest('A newer arrival'));
      await acknowledgeShared(reread); expect(present).toBe(true);
      await takeShared(); await acknowledgeShared(useShared.getState().shared!); expect(present).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks');
      useShared.setState({ shared: null }); setConversationState({ open: false });
    }
  });
});

describe('share acknowledgement without Web Locks', () => {
  it('persists an individual receipt, so a reload cannot insert the consumed share again', async () => {
    const { vi } = await import('vitest');
    const { takeShared, acknowledgeShared, useShared } = await import('@/features/coordinator/shared');
    const rows = new Map<string, Response>([['/share/list', new Response(snapshotJson({ at: 1, title: '', text: 'Old but still pending', url: '', files: [] }))]]);
    const oldManifest = await rows.get('/share/list')!.clone().text();
    rows.set(`/share/claimed?receipt=${encodeURIComponent(oldManifest)}`, new Response('claimed'));
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    vi.stubGlobal('caches', { has: async () => true, open: async () => ({ match: async (key: string) => rows.get(key)?.clone(), put: async (key: string, response: Response) => { rows.set(key, response); } }) });
    try {
      await takeShared(); const shared = useShared.getState().shared!;
      expect(shared.text).toBe('Old but still pending');
      await acknowledgeShared(shared); await takeShared(); expect(useShared.getState().shared).toBeNull();
    } finally {
      vi.unstubAllGlobals(); useShared.setState({ shared: null });
      if (locks) Object.defineProperty(navigator, 'locks', locks); else Reflect.deleteProperty(navigator, 'locks');
    }
  });
});
