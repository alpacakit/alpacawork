// These formats contain no zone name. Project local calendar fields into UTC so the two shared
// formatters stay correct even when the device changes zone, without constructing Intl for every message.
let formats: { language: string; today: Intl.DateTimeFormat; earlier: Intl.DateTimeFormat } | undefined;
export function messageTime(at: string, language: string) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return date.toString();
  if (formats?.language !== language) {
    const options = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' } as const;
    formats = { language, today: new Intl.DateTimeFormat(language, options),
      earlier: new Intl.DateTimeFormat(language, { ...options, month: 'numeric', day: 'numeric' }) };
  }
  const local = new Date(0);
  local.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  local.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  const earlier = date.toDateString() !== new Date().toDateString();
  // A zone offset can put the projected fields outside Date's representable endpoints.
  if (Number.isNaN(local.getTime())) return date.toLocaleString(language, { ...(earlier ? { month: 'numeric', day: 'numeric' } : {}),
    hour: '2-digit', minute: '2-digit', hour12: false });
  return (earlier ? formats.earlier : formats.today).format(local);
}
