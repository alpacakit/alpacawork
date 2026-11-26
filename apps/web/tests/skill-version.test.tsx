import { describe, expect, it } from "vitest";
import { skillVersionState } from "@/domain/skill-version";

const repo = { bundled: false, installed: true };
describe("skillVersionState", () => {
  it("offers an update only when GitHub has changed the skill since it was installed", () => {
    expect(skillVersionState({ ...repo, installedAt: "2026-11-02T00:00:00Z", latestAt: "2026-11-20T00:00:00Z" }).kind).toBe("behind");
    expect(skillVersionState({ ...repo, installedAt: "2026-11-20T00:00:00Z", latestAt: "2026-11-20T00:00:00Z" }).kind).toBe("current");
  });
  it("offers an update when the installed day is not known, but not when the latest could not be read", () => {
    expect(skillVersionState({ ...repo, installedAt: null, latestAt: "2026-11-20T00:00:00Z" }).kind).toBe("behind");
    expect(skillVersionState({ ...repo, installedAt: null, latestAt: null }).kind).toBe("installed");
  });
  it("never offers an update for a skill that comes with alpacawork", () => {
    expect(skillVersionState({ bundled: true, installed: true, installedAt: null, latestAt: "2026-11-20T00:00:00Z" }).kind).toBe("installed");
    expect(skillVersionState({ bundled: true, installed: false, installedAt: null, latestAt: null }).kind).toBe("absent");
  });
});
