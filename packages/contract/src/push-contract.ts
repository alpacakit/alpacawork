/** Web Push wire contract shared by the screen and server. */
import { z } from "zod";

/** Browser push services accepted as destinations for subscription and delivery. */
const ENDPOINT_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const ENDPOINT_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];
export function endpointAllowed(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return ENDPOINT_HOSTS.includes(host) ||
    ENDPOINT_SUFFIXES.some(suffix => host.endsWith(suffix) && host.length > suffix.length && !host.slice(0, -suffix.length).includes('.'));
}

/** A browser subscription as `PushSubscription.toJSON()` returns it. */
export const pushSubscriptionSchema = z.object({
  endpoint: z.url().refine(endpointAllowed, 'Subscription endpoint is not a known browser push service over https'),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }).strict(),
}).strict();
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const pushKeySchema = z.object({ key: z.string().min(1) }).strict();
/** One registered device; the endpoint lets the browser recognise its own row. */
export const pushDeviceSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  endpoint: z.url(),
  created_at: z.string(),
}).strict();
export const pushDevicesSchema = z.object({ devices: z.array(pushDeviceSchema) }).strict();
export const pushSubscribeResponseSchema = z.object({ id: z.string().min(1) }).strict();
export const pushUnsubscribeResponseSchema = z.object({ removed: z.boolean() }).strict();
export type PushDevice = z.infer<typeof pushDeviceSchema>;

/** The encrypted payload a Service Worker receives; `tag` collapses repeats of one event. */
export const pushPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(1000),
  url: z.string().max(200).regex(/^\/(?:\?[^\s#]*)?$/),
  tag: z.string().min(1).max(200),
}).strict();
export type PushPayload = z.infer<typeof pushPayloadSchema>;
