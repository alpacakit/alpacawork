import { createWorkspacePerformanceReceiver } from './diagnostics/receiver.js';
declare const __DIAGNOSTIC_RELEASE__: string;
export const createPerformanceReceiver = (workspace: string) => createWorkspacePerformanceReceiver(workspace, __DIAGNOSTIC_RELEASE__);
