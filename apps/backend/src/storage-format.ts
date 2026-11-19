/** Execution contract, including the responsible agent CLI input contract. SQL schema and persisted control records never enter FORMAT. */
import { protocolFingerprint } from '@alpacawork/contract/run-protocol';
process.stdout.write(`${protocolFingerprint()}\n`);
