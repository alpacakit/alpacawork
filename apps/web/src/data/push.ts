import { workspaceWriteBasis } from './connection';
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
 * Whether this browser could receive notifications but does not: it can (pushSupported), the person has not blocked
 * them, and it holds no subscription. Read as the screen opens and again as each dialog closes (Settings is where they
 * are turned on); false until it is read, and where the read fails.
 */
export function usePushOff(): boolean {
  const dialog = useDialogStore((state) => state.dialog?.kind ?? null);
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (dialog !== null) return;
    if (!pushSupported() || Notification.permission === "denied") { setOff(false); return; }
    let live = true;
    currentSubscription().then((subscription) => { if (live) setOff(subscription === null); },
      (error: unknown) => { recordFailure(error, "push subscription read"); if (live) setOff(false); });
    return () => { live = false; };
  }, [dialog]);
  return off;
}
/** Ask permission, subscribe with serve's key, and register the subscription. */
export function useSubscribePush() {
  const client = useQueryClient();
  // The browser's own refusal (its push service) is said as this device not being registered, not as a screen fault.
  return useMutation({ meta: { errorToast: false },
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
    onError: error => notify.failure(error, { about: "push unsubscribe", text: error instanceof ApiError ? undefined : i18n.t("panels:push.unsubscribeFailed") }),
    mutationFn: async (device: Pick<PushDevice, "id"> & { own?: PushSubscription | null }) => {
    if (device.own) await device.own.unsubscribe();
    await api.request("notify/unsubscribe", pushUnsubscribeResponseSchema, undefined, { id: device.id }, undefined, workspaceWriteBasis());
    await client.invalidateQueries({ queryKey: resources.pushDevices().queryKey });
  } });
}
