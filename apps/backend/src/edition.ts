/** Production assembly. The diagnostic Vite build selects edition.diagnostic.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http';
type Receiver = { handle(request: IncomingMessage, response: ServerResponse, origin: string): boolean; close(): Promise<void> };
export const createPerformanceReceiver: ((root: string) => Receiver) | undefined = undefined;
