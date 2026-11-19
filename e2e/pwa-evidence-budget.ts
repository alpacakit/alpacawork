/** The longest each stage of a kept runtime's teardown may take. */
export const recoveryStageMs = { capture: 60_000, trace: 30_000, close: 30_000, stop: 20_000 } as const;
