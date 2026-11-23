import { workspaceWriteBasis } from './connection';
import { useEffect } from "react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pushSubscribeResponseSchema, pushUnsubscribeResponseSchema, type PushDevice } from "@alpacawork/contract";
import { taskAtAddress, type TaskIndex } from "@/domain/tasks";
import { useDialogStore } from "@/state/dialog-store";
import { urlValue, writeUrlValue } from "@/state/screen-settings";
import { useViewStore } from "@/state/view-store";
import { api } from "./queries";
import { resources } from "./resources";
import { ApiError } from "./client";
import { i18n } from "@alpacawork/i18n";
import { notify, recordFailure } from "@/lib/notify";

/**
 * Web Push from this browser: the Service Worker that shows
 * the notifications, this browser's subscription with serve, and the registered
 * devices. Push needs a secure context, a Service Worker and the Push API; an
 * iPhone has them only as a Home Screen web app.
 */
export const pushSupported = () =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;

/** Registered once at start-up; nothing else depends on it, so a failure is only logged. */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => recordFailure(error, "service worker registration"));
}

/** The host push opens Settings > Host status (`/?settings=host`). */
const openSettingsTab = (tab: unknown) => {
  if (tab === "host") useDialogStore.getState().open("settings", { tab: "host" });
};

/**
 * A tapped notification asks the open window to move to its task, or to open the settings tab it names
 * (sw.js `notificationclick`). A window the tap opened reads the same from its URL once.
 */
export function useOpenFromNotification(index: TaskIndex) {
  useEffect(() => {
    const tab = urlValue("settings");
    if (tab === null) return;
    writeUrlValue("settings", null);
    openSettingsTab(tab);
  }, []);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== "open-task") return;
      openSettingsTab((data as { settings?: unknown }).settings);
      // The notice names its task as the screen's URL does (its ID); opening it outside the project in view widens the
      // list to every project (state/bootstrap.ts).
      const address = (data as { task?: unknown }).task;
      const task = typeof address === "string" ? taskAtAddress(address, index) : undefined;
      if (task) useViewStore.getState().openTask(task.id, { reader: true });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [index]);
}

/** A short name for the device list, from the user agent: browser and platform. */
export function deviceLabel(userAgent = navigator.userAgent): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Firefox\//.test(userAgent) ? "Firefox"
    : /Chrome\//.test(userAgent) ? "Chrome" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const platform = /Android/.test(userAgent) ? "Android" : /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad"
    : /Macintosh/.test(userAgent) ? "Mac" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  return platform ? `${browser} · ${platform}` : browser;
}

export function usePushDevices(enabled = true) {
  return useQuery({ ...resources.pushDevices(), enabled });
}

function applicationServerKey(key: string): Uint8Array<ArrayBuffer> {
  const padded = key + "=".repeat((4 - (key.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
export async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}
/**
 * This browser's own side of push, read as one: whether the person allows notifications here, and its subscription (a
 * read that fails counts as none, its failure recorded). Kept while read again, and read again as the window comes back
 * into view, so a change made elsewhere (in another tab, in the browser's settings) is seen.
 */
const pushHere = () => queryOptions({ queryKey: ["push-here"] as const, staleTime: 0, refetchOnWindowFocus: true,
  queryFn: async (): Promise<{ permission: NotificationPermission; subscription: PushSubscription | null }> => ({
    permission: Notification.permission,
    subscription: await currentSubscription().catch((error: unknown) => { recordFailure(error, "push subscription read"); return null; }),
  }) });
/** This browser's side of push (pushHere), read only where push is supported and `enabled`. */
export const usePushHere = (enabled = true) => useQuery({ ...pushHere(), enabled: enabled && pushSupported() });

/**
 * Whether this browser receives notifications: `unsupported` without push, `blocked` by the person, `on` when it holds a
 * subscription serve lists among its devices (both sides agree), else `off` (none here, or one serve no longer knows,
 * removed from another device: offered again). Undefined while either side is not read yet.
 */
export type PushReceiving = "unsupported" | "blocked" | "on" | "off";
export function receivingPush(supported: boolean, here: { permission: NotificationPermission; subscription: { endpoint: string } | null } | undefined,
  devices: readonly { endpoint: string }[] | undefined): PushReceiving | undefined {
  if (!supported) return "unsupported";
  if (!here) return undefined;
  if (here.permission === "denied") return "blocked";
  if (!devices) return undefined;
  return here.subscription && devices.some((device) => device.endpoint === here.subscription!.endpoint) ? "on" : "off";
}
/** This browser's push state (receivingPush), from what it and serve say; nothing is read unless `enabled`. */
export function useReceivingPush(enabled = true): PushReceiving | undefined {
  const here = usePushHere(enabled);
  const devices = usePushDevices(enabled && pushSupported());
  return receivingPush(pushSupported(), here.data, devices.data?.devices);
}
/** Ask permission, subscribe with serve's key, and register the subscription. */
export function useSubscribePush() {
  const client = useQueryClient();
  // The browser's own refusal (its push service) is said as this device not being registered, not as a screen fault.
  return useMutation({ meta: { errorToast: false },
    // Whatever came of it, the permission and the subscription here are read again.
    onSettled: () => client.invalidateQueries({ queryKey: pushHere().queryKey }),
    onError: error => notify.failure(error, { about: "push subscribe", text: error instanceof ApiError ? undefined : i18n.t("panels:push.subscribeFailed") }),
    mutationFn: async () => {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { permission };
    const registration = await navigator.serviceWorker.ready;
    const { key } = await client.fetchQuery(resources.pushKey());
    const subscription = (await registration.pushManager.getSubscription())
      ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(key) });
    await api.request("notify/subscribe", pushSubscribeResponseSchema, undefined, { subscription: subscription.toJSON(), label: deviceLabel() }, undefined, workspaceWriteBasis());
    await client.invalidateQueries({ queryKey: resources.pushDevices().queryKey });
    return { permission, endpoint: subscription.endpoint };
  } });
}
/** Remove a device from serve; for this browser, also drop its subscription. */
export function useUnsubscribePush() {
  const client = useQueryClient();
  return useMutation({ meta: { errorToast: false },
    onSettled: () => client.invalidateQueries({ queryKey: pushHere().queryKey }),
    onError: error => notify.failure(error, { about: "push unsubscribe", text: error instanceof ApiError ? undefined : i18n.t("panels:push.unsubscribeFailed") }),
    mutationFn: async (device: Pick<PushDevice, "id"> & { own?: PushSubscription | null }) => {
    if (device.own) await device.own.unsubscribe();
    await api.request("notify/unsubscribe", pushUnsubscribeResponseSchema, undefined, { id: device.id }, undefined, workspaceWriteBasis());
    await client.invalidateQueries({ queryKey: resources.pushDevices().queryKey });
  } });
}
