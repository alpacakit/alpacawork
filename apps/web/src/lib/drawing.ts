/** The source of a painted value, captured with that value, rather than read later by an effect. */
export type DrawingSource = { root: string; restoredAt: number | null };
export const sameDrawingSource = (a: DrawingSource, b: DrawingSource) => a.root === b.root && a.restoredAt === b.restoredAt;
/** A saved value establishes a baseline; only two observations made live describe a new change. */
export const continuesDrawing = (a: DrawingSource, b: DrawingSource) => a.root === b.root && a.restoredAt === null && b.restoredAt === null;
export const liveDrawing: DrawingSource = { root: "", restoredAt: null };
