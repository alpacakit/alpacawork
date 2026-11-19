import type { ReactNode } from "react";
import { Message } from "./message";

/** What a costly action will do, beside its final button: the shared band, as a caution. */
export function ConsequenceNote({ children }: { children: ReactNode }) {
  return <Message size="band" tone="caution" className="mt-type-block" title={children} />;
}
