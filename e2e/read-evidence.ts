export async function readSnapshot(page: any) {
  return page.evaluate(async () => {
    const root = document.getElementById('root');
    let client: any, workspace: any; const seen = new Set();
    const walk = (f: any) => { if (!f || seen.has(f)) return; seen.add(f); if (f.memoizedProps?.client?.getQueryCache) client = f.memoizedProps.client; const value = f.memoizedProps?.value; if (value?.getState && Array.isArray(value.getState()?.tasks) && value.getState()?.info?.root) workspace = value.getState(); walk(f.child); walk(f.sibling); walk(f.stateNode?.current); };
    const key = root && Object.keys(root).find(k => k.startsWith('__reactContainer'));
    if (key) walk((root as any)[key]);
    const queries = client?.getQueryCache().getAll().map((q: any) => ({ key: q.queryKey, state: q.state }));
    const databases = await indexedDB.databases(); let idb: unknown = null;
    if (databases.some(d => d.name === 'alpacawork-read-checkpoint')) idb = await new Promise((resolve, reject) => {
      const r = indexedDB.open('alpacawork-read-checkpoint'); r.onerror = () => reject(r.error);
      r.onsuccess = () => { const db = r.result; const tx = db.transaction(['control','slots']); const c = tx.objectStore('control').get('current'), s = tx.objectStore('slots').getAll(); tx.oncomplete = () => { db.close(); resolve({control:c.result,slots:s.result}); }; tx.onabort = () => { db.close(); reject(tx.error); }; };
    });
    return { subject: (window as any).__subjectEvidence, at: Date.now(), url: location.href, queries, idb, workspace: workspace && { root: workspace.info.root, tasks: workspace.tasks.map((task: any) => ({ id: task.id, state: task.state, parent: task.parent })) }, html: document.body?.innerHTML };
  });
}