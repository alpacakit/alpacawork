import { defineConfig } from 'vite';
import web from '../../apps/web/vite.config';

/** Diagnostic handles only in this profiling build; production has no bridge. */
export default defineConfig(env => {
  const config = web(env);
  return { ...config, plugins: [...config.plugins!, {
    name: 'render-subscriptions-bridge',
    transform(code: string, id: string) {
      if (id.endsWith('/features/coordinator/coordinator.ts'))
        return code + '\nwindow.__renderProbeConversation = useConversation;';
      if (id.endsWith('/data/workspace-store.ts'))
        return code.replace('return store;', 'window.__renderProbeWorkspace = store; return store;');
    },
  }] };
});
