import { TELEMETRY_FIELDS } from '@alpacawork/contract/telemetry';

/**
 * A value each kind of information could have in a report, shown beside what it is when the person is asked again.
 * Written out per field: a field without one fails the test (tests/telemetry-fields), so a new field is never asked
 * about by its name alone.
 */
export const TELEMETRY_FIELD_EXAMPLES: Readonly<Record<string, string>> = {
  schema: '2', id: '0b5c3a1e-7d2f-4c8a-9e61-2f4d8b7a0c35', day: '2026-11-24', version: '0.1.7', os: 'linux', arch: 'x64', node: '24',
  events: '["send.button", 3, "phone.android", "screen", "ja", "dark"]',
  'events.device': 'phone.android', 'events.via': 'screen', 'events.lang': 'ja', 'events.theme': 'dark',
  failures: '{"exit": "1-5"}', 'failures.exit': '1-5', 'failures.output': '1-5', 'failures.timeout': '1-5', 'failures.launch': '1-5',
  'failures.conversation_busy': '1-5', 'failures.attachment_save': '1-5', 'failures.manager_lost': '1-5',
  shape: '{"tasks": "20-49"}', 'shape.projects': '3-4', 'shape.tasks': '20-49', 'shape.open': '5-9', 'shape.depth': '3-4',
  'shape.children': '5-9', 'shape.top': '10-19', 'shape.turns': '20-49', 'shape.talk': '20-49', 'shape.parallel': '3-4',
  times: '{"open": ["0.5-1s", "1-2s"]}', 'times.open': '0.5-1s, 1-2s', 'times.task': '<0.25s, 0.25-0.5s', agents: 'claude, codex',
};

/** The words key of a field: dots would nest the key, so they become underscores. */
export const telemetryFieldKey = (field: string) => `telemetry.fields.${field.replaceAll('.', '_')}`;

export const telemetryFieldsWithoutExample = () => TELEMETRY_FIELDS.filter(field => !TELEMETRY_FIELD_EXAMPLES[field]);
