import { useEffect, useRef, type FocusEvent, type PointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readScheduler } from "./read-scheduler";

/** A brief hover is ignored; keyboard and touch intent asks at once. The read scheduler reads the Task's view ahead. */
export function usePrefetch(taskId: string) {
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useRef(taskId);
  id.current = taskId;
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const start = () => { cancel(); readScheduler(client)?.pointed(id.current); };
  useEffect(() => cancel, []);
  return {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      cancel();
      timer.current = setTimeout(start, 100);
    },
    onPointerLeave: cancel,
    onPointerDown: (event: PointerEvent<HTMLElement>) => { if (event.pointerType === "touch") start(); },
    onFocus: (event: FocusEvent<HTMLElement>) => { if (event.currentTarget.matches(":focus-visible")) start(); },
    onBlur: cancel,
  };
}
