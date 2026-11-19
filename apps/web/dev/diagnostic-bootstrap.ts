import { startPerformance } from './performance-client.ts';
declare const __PERFORMANCE_BUILD__: string;
startPerformance({ buildId: __PERFORMANCE_BUILD__, componentNames: false });
// The dynamic edge makes installing the hook a prerequisite of evaluating React.
void import('../src/main.tsx');
