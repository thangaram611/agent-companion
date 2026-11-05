import '../sandbox-home.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';
import { cleanupExecution } from '../../scripts/cleanup-watcher.mjs';
import { ManualClock, until } from './helpers.mjs';
import { fixtureSupervisor } from './fixture-table.mjs';

const clock = new ManualClock();
const records = new Records({ dir: process.argv[2] });
const execution = records.readExecution(process.argv[3]);
let supervisor;
const cleanup = cleanupExecution({ records, execution, clock, createSupervisor: (options) => { supervisor = fixtureSupervisor(options); return supervisor; } });
await until(() => [...clock.timers.values()].some((timer) => timer.at === 2000));
await clock.advance(2000);
await until(() => supervisor.lastSignals.some((signal) => signal.signal === 'SIGKILL'));
await until(async () => (await supervisor.verifyGone()).gone, 'watcher verification of fixture absence');
await clock.advance(500);
const result = await cleanup;
process.send?.({ gone: result.stopEvidence.gone });
process.disconnect?.();
