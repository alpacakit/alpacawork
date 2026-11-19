import { useEffect, useRef, useState } from "react";
import { taskFileUrl } from "@/data/task-file-url";
import type { TaskFile } from "@/domain/task-files";
import { cn } from "@/lib/utils";

export const isHtml = (name: string) => /\.html$/i.test(name);

/** The frame's height before the page says its own, and the most it may take. */
const FIRST_HEIGHT = 320;
const MAX_HEIGHT = 6000;

/**
 * A Task-folder HTML page (a mock, a review page) to look at in place: a sandboxed iframe with scripts on and no origin,
 * so the page cannot reach this screen, its cookies, the API, or move the page above. The server sends it with its own
 * policy and a first script that says the page's height; the frame takes that height so the page reads as one scroll.
 * Answers are not taken from the page: they are given on the question's card.
 */
export function HtmlFrame({ taskId, file, className }: { taskId: string; file: TaskFile; className?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(FIRST_HEIGHT);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // The frame's origin is opaque ("null"), so its own window is the check.
      if (event.source !== frame.current?.contentWindow || typeof event.data !== "object" || !event.data?.alpacaworkFrame) return;
      if (typeof event.data.height === "number") setHeight(Math.min(Math.max(Math.ceil(event.data.height), 120), MAX_HEIGHT));
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, []);
  const url = taskFileUrl(taskId, file.name, file.revision);
  return <iframe ref={frame} data-html-frame={file.name} title={file.name} src={`${url}${url.includes("?") ? "&" : "?"}frame=1`}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    className={cn("block w-full rounded-md border border-line bg-paper", className)} style={{ height }} />;
}
