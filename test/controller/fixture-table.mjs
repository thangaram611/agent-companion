import { once } from 'node:events';
import { pidAlive } from '../../bridge-server/controller/process-supervisor.mjs';
import { ProcessSupervisor } from '../../bridge-server/controller/process-supervisor.mjs';

// This is deliberately test-only: identities and group ancestry come from our
// fixture's IPC, NOT the OS census. Production always uses ps. A separate test
// below qualifies that path on hosts where the sandbox permits ps.
export function fixtureSupervisor(options) {
  let rows = options.record?.processes || [];
  let ready;
  const supervisor = new ProcessSupervisor({ ...options, processTable: async () => {
    if (!rows.length && supervisor.child) {
      ready ??= once(supervisor.child, 'message').then(([message]) => { supervisor.fixture = message; rows = message.rows; });
      await ready;
    }
    return new Map(rows.filter((row) => pidAlive(row.pid)).map((row) => [row.pid, row]));
  } });
  return supervisor;
}

