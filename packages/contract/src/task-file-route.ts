export const taskFilePath = '/api/tasks/:task/file';
export const attachmentsPath = '/api/tasks/:task/attachments';
/** A Task file's URL, the same for every reader (CLI, screen, an agent's start text); no path names the Task's folder. */
export const taskFileRoute = (task: string, path = '') =>
  `${taskFilePath.replace(':task', encodeURIComponent(task))}?path=${encodeURIComponent(path)}`;
/** The reverse of `taskFileRoute`: the Task and path a URL of that route names; null for any other URL, or one with no path. */
export function parseTaskFileRoute(url: Pick<URL, 'pathname' | 'searchParams'>): { task: string; path: string } | null {
  const route = /^\/api\/tasks\/([^/]+)\/file$/.exec(url.pathname);
  const path = url.searchParams.get('path');
  if (!route || !path) return null;
  try { return { task: decodeURIComponent(route[1]!), path }; } catch { return { task: route[1]!, path }; }
}
