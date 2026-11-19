import { startTransition } from "react";

export type Press = { root: string; conversationId: string; target: string; action: 'send-now' | 'clear' };
// Synchronous admission for the optimistic presses. It owns no saved intent or server state, only their lifetimes.
const pressing = new Map<string, Promise<void>>();
const pressKey = (press: Press) => JSON.stringify([press.root, press.conversationId, press.target, press.action]);
export const clearingConversation = (root: string, conversationId: string) => pressing.get(pressKey({ root, conversationId, target: conversationId, action: 'clear' }));
export function press(pressed: Press, work: () => Promise<void>, show: (press: Press) => void = () => {}) {
  const key = pressKey(pressed), existing = pressing.get(key);
  if (existing) return Promise.resolve(); // The first press alone owns its result notice.
  let resolve!: () => void, reject!: (error: unknown) => void;
  const flight = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  pressing.set(key, flight);
  startTransition(async () => {
    show(pressed);
    try { await work(); resolve(); }
    catch (error) { reject(error); }
    finally { if (pressing.get(key) === flight) pressing.delete(key); }
  });
  return flight;
}

