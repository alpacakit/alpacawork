import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { skillInstallRequestSchema, skillInstallResponseSchema, skillJobSchema, skillsLatestResponseSchema, skillsResponseSchema,
  type SkillJob, type SkillName } from "@alpacawork/contract";
import { ApiError, retryOf } from "./client";
import { workspaceWriteBasis } from "./connection";
import { useWorkspaceInfo } from "./queries";
import { api } from "./resources";

/** The offered skills on this PC (which are installed), where they go, and the install the server is running. */
export function useSkills() {
  const root = useWorkspaceInfo((info) => info.root);
  return useQuery({
    queryKey: ["skills", root] as const,
    queryFn: ({ signal }) => api.request("skills", skillsResponseSchema, signal),
    // What is installed changes outside this screen: each opening reads it afresh.
    staleTime: 0,
  });
}

/**
 * The latest version of each skill fetched from GitHub (the day its folder there last changed), read as Settings opens
 * apart from the list, so the list never waits on GitHub; a day not read is null.
 */
export function useSkillLatest() {
  const root = useWorkspaceInfo((info) => info.root);
  return useQuery({
    queryKey: ["skills-latest", root] as const,
    queryFn: ({ signal }) => api.request("skills/latest", skillsLatestResponseSchema, signal),
    staleTime: 0,
  });
}

/** Where an install stands: not asked; running or finished (its rows); or a request whose answer did not come. */
export type SkillInstall =
  | { phase: "idle" }
  /** Asked, its answer not come yet: nothing else is asked meanwhile. */
  | { phase: "sending" }
  | { phase: "running" | "finished"; job: SkillJob }
  | { phase: "failed"; error: unknown };

const POLL_MS = 1000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Installs the skills named, as one job at the server, and follows it to its end by reading the skills each second
 * (each read is what `useSkills` shows, so a row reads installed as soon as it is). A job already running (answered busy,
 * or found on opening) is followed rather than started over. A request whose answer was lost is sent again with its
 * operation ID, so the server answers it with the job it started; one that was refused is let go.
 */
export function useSkillInstall() {
  const client = useQueryClient();
  const root = useWorkspaceInfo((info) => info.root);
  const [install, setInstall] = useState<SkillInstall>({ phase: "idle" });
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const sent = useRef<{ names: SkillName[]; opId: string } | null>(null);

  const follow = async (first: SkillJob) => {
    let job = first;
    while (live.current && !job.finished) {
      setInstall({ phase: "running", job });
      await wait(POLL_MS);
      try {
        const read = await api.request("skills", skillsResponseSchema);
        client.setQueryData(["skills", root], read);
        // The job is gone (the server restarted): what it had done stands, the rest did not finish.
        job = read.job?.id === job.id ? read.job : { ...job, finished: true, items: job.items.map(item => item.state === "done" || item.state === "failed"
          ? item : { name: item.name, state: "failed" as const, reason: "other" as const }) };
      } catch (error) { if (live.current) setInstall({ phase: "failed", error }); return; }
    }
    if (live.current) setInstall({ phase: "finished", job });
  };
  const start = async (names: SkillName[]) => {
    const same = sent.current && sent.current.names.join() === names.join() ? sent.current : null;
    const request = same ?? { names: [...names], opId: crypto.randomUUID() };
    sent.current = request;
    setInstall({ phase: "sending" });
    let job: SkillJob;
    try {
      ({ job } = await api.request("skills/install", skillInstallResponseSchema, undefined,
        skillInstallRequestSchema.parse({ names: request.names }), request.opId, workspaceWriteBasis()));
    } catch (error) {
      const running = error instanceof ApiError && error.code === "busy"
        && skillJobSchema.safeParse((error.detail as { job?: unknown } | undefined)?.job);
      if (!running || !running.success) {
        // Only an answer that never came is sent again as it was; a refusal starts afresh.
        if (retryOf(error) !== "check") sent.current = null;
        if (live.current) setInstall({ phase: "failed", error });
        return;
      }
      job = running.data;
    }
    sent.current = null;
    await follow(job);
  };
  return { install, start, follow };
}
