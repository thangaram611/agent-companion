// Test-only extension in the disposable profile. Exercise the native tool
// pipeline, including pre/post hooks and normal Copilot approval rules.
import { joinSession } from '@microsoft/copilot-sdk/extension';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.AGENT_COMPANION_JOB === undefined) {
  const session = await joinSession({ tools: [], hooks: {} });
  const base = join(process.env.COPILOT_HOME, 'probe-' + session.sessionId);
  writeFileSync(base + '.ready', '');
  setInterval(async () => {
    if (!existsSync(base + '.call')) return;
    renameSync(base + '.call', base + '.running');
    let output;
    try {
      const request = JSON.parse(readFileSync(base + '.running'));
      const result = await session.rpc.tools.execute(request);
      output = result;
    } catch (err) { output = { error: String(err) }; }
    writeFileSync(base + '.pending', JSON.stringify(output));
    renameSync(base + '.pending', base + '.result');
  }, 100);
}
