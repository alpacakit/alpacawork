import { describe, expect, it } from "vitest";
import type { RunStep } from "@alpacawork/contract/run";
import { awaitedStep, programOf } from "@/domain/run-activity";

const step = (over: Partial<RunStep>): RunStep => ({ id: "s", at: "2026-01-01T00:00:00Z", tool: "Bash", kind: "command", text: "",
  more: 0, about: null, state: "running", result: null, ...over });

describe("what a silent Run waits on", () => {
  it("names the program a command runs, past setup, variables and wrappers", () => {
    expect(programOf("cd /repo && gh run watch 123 --exit-status")).toBe("gh");
    expect(programOf("FOO=1 timeout 600 /usr/bin/ffmpeg -f x11grab -i :0 out.mp4 | tail -1")).toBe("ffmpeg");
    expect(programOf("sudo -E pnpm test:quick; echo done")).toBe("pnpm");
    expect(programOf("cd /work/kit; rm -rf take; kit/run-take.sh; grep -c frame take/log")).toBe("run-take.sh");
    expect(programOf("until gh run view 1 --json status | grep -q completed; do sleep 30; done")).toBe("gh");
    expect(programOf("for v in a b; do ffmpeg -i $v.mov $v.mp4; done")).toBe("ffmpeg");
    expect(programOf("bash -lc 'cd /repo && ffmpeg -y -i in.mov out.mp4'")).toBe("ffmpeg");
    expect(programOf("if [ -f x ]; then pnpm build; fi")).toBe("pnpm");
    expect(programOf("ls -la")).toBe("ls");
  });

  it("is the latest step still running, and nothing once every step has ended", () => {
    expect(awaitedStep([step({ id: "a", text: "sleep 900" }), step({ id: "b", text: "ls", state: "done" })])?.name).toBe("sleep");
    expect(awaitedStep([step({ tool: "collab_tool_call", kind: "tool", text: "review" })])?.name).toBe("Agent");
    expect(awaitedStep([step({ state: "done" }), step({ state: "failed" })])).toBeNull();
    expect(awaitedStep(undefined)).toBeNull();
  });
});
