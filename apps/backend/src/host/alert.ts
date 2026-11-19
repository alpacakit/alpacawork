/** The one push sent when a tight episode begins: what was tight for how long, and the heaviest Tasks. */
import { serverText, type ServerLocale } from '@alpacawork/i18n/server';
import type { Derived } from '../receiver/push.js';
import { hostPushKey } from '../receiver/push.js';
import { PRESSURE_LIMITS } from './pressure.js';
import type { HostSample } from './measure.js';
import type { EpisodeDraft } from './store.js';

const GB = 1024 ** 3;
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
/** Where a push opens: the settings dialog on Machine status. */
const HOST_STATUS_URL = '/?settings=host';

export function hostPushEvent(episode: EpisodeDraft, sample: HostSample, language: ServerLocale): Derived {
  const t = serverText(language);
  const memory = 100 * sample.memory.availableBytes / sample.memory.totalBytes;
  const parts = episode.kinds.map(kind => {
    if (kind === 'cpu') return t('server:hostAlert.cpu', { percent: Math.round(sample.cpu ?? 0), minutes: minutes(PRESSURE_LIMITS.cpu.tightFor) });
    if (kind === 'memory') return t('server:hostAlert.memory', { percent: Math.round(memory), minutes: minutes(PRESSURE_LIMITS.memory.tightFor) });
    return t('server:hostAlert.disk', { gigabytes: Math.round(sample.disk.freeBytes / GB) });
  });
  const tasks = [...new Set([...sample.runs].sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1)).map(run => run.taskId ?? t('server:hostAlert.coordinator')))].slice(0, 3);
  const heaviest = !sample.runs.length ? t('server:hostAlert.noRuns')
    : t('server:hostAlert.heaviest', { tasks: tasks.join(t('server:hostAlert.taskSeparator')), count: sample.runs.length });
  const key = hostPushKey(episode.start);
  return {
    key, urgency: 'high', occurredAt: new Date(episode.start).toISOString(),
    payload: {
      title: t('server:hostAlert.title'),
      body: t('server:hostAlert.body', { parts: parts.join(t('server:hostAlert.partSeparator')), heaviest }),
      url: HOST_STATUS_URL, tag: key,
    },
  };
}
