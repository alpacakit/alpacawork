/** Public document types must accept exactly the schema output, never wider values. */
import type { TaskActor, TaskLog } from '@alpacawork/raw';
import type { TaskActor as SchemaActor, TaskLog as SchemaLog } from '@alpacawork/raw/task-log-schema';

type Expect<T extends true> = T;
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type ActorMatchesSchema = Expect<Same<TaskActor, SchemaActor>>;
type LogMatchesSchema = Expect<Same<TaskLog, SchemaLog>>;
