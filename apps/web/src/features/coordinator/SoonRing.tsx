import { useMemo } from 'react';
import { writeGraceMs } from '@/data/send-grace';
/** The remaining grace is drawn on the message, without creating another clock or notification. */
export function SoonRing({ until }: { until?: number }) {
  const animation = useMemo(() => {
    const duration = writeGraceMs(), remaining = Math.max(0, (until ?? Date.now() + duration) - Date.now());
    return `send-grace-ring ${duration}ms linear ${Math.min(0, remaining - duration)}ms forwards`;
  }, [until]);
  return <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 flex-none -rotate-90 text-working">
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
    <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="37.7"
      style={{ animation }} />
  </svg>;
}
