import { useViewStore } from "@/state/view-store";
import { analysisHome, belowLayer, type AnalysisPlace } from "./place";

/** Where the analysis was last left, its layers closed: coming back to it finds it so. */
let left: AnalysisPlace | null = null;
useViewStore.subscribe(state => { if (state.analysis) left = belowLayer(state.analysis, 0); });

/** Opens the analysis face where it was last left (its first look, the default span, the first time). */
export const openAnalysis = () => useViewStore.getState().showAnalysis(left ?? analysisHome());
