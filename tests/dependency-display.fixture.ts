/** Synthetic dependency scenes driven by the same commands as real tasks; no provider runs. */
import { taskFlow } from './task-flow.fixture.ts';

export async function dependencyDisplay(t: { after(cleanup: () => void): unknown }) {
  const f = await taskFlow(t);
  const a = await f.task('仕様を確認する'), c = await f.task('図面をそろえる'), b = await f.task('まとめて実装する');
  const child = await f.task('手順を整える', { parentId: b.id });
  await f.person(a.id, 'held');
  const set = async (task: string, after: string[]) => f.commands.dependencies({ task, after, expectedTaskHash: (await f.get(task)).hash });
  const next = await f.task('次の段階へ進む'); await set(next.id, [b.id]);
  await set(b.id, [c.id]); await set(b.id, [a.id, c.id]); await set(child.id, [a.id]);
  const records = (await f.get(b.id)).meta.log.filter(log => log.kind === 'dependencies_changed');
  const cleared = await f.task('順序を外した作業'); await set(cleared.id, [c.id]); await set(cleared.id, []);
  const ended = await f.task('準備が終わった作業'); await f.person(ended.id, 'stopped');
  const begun = await f.task('準備のあとに始まった作業'); await set(begun.id, [ended.id]);
  const run = await f.work(begun); f.end(run);
  const stoppedFollower = await f.task('始まる前に中止した後続');
  await set(stoppedFollower.id, [a.id]); await f.person(stoppedFollower.id, 'stopped');
  return { f, a, b, c, next, stoppedFollower, child, cleared, begun, ended, records };
}
