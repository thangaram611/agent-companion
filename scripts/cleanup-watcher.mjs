import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Records } from '../bridge-server/controller/records.mjs';
import { ProcessSupervisor } from '../bridge-server/controller/process-supervisor.mjs';
import { systemClock } from '../bridge-server/controller/clock.mjs';

// The watcher owns no provider protocol and can never resume or deliver work.
// Its only durable write is the fenced, immutable result for this execution.
export async function cleanupExecution({ execution, records = new Records(), clock = systemClock, createSupervisor = (opts) => new ProcessSupervisor(opts) }) {
  const conversation = records.readConversation(execution.owner);
  const current = records.readExecution(execution.executionId);
  if (conversation?.generation !== execution.generation || current?.writer !== 'watcher') {
    records.log({ code: 'stale_generation', owner: execution.owner, generation: execution.generation });
    return null;
  }
  const supervisor = createSupervisor({ record: execution.processes, clock });
  const stopEvidence = await supervisor.terminate();
  const native = execution.terminal;
  const result = {
    owner: execution.owner, executionId: execution.executionId, generation: execution.generation,
    outcome: native?.outcome || (stopEvidence.gone ? 'stopped' : 'failed'), cause: 'bridge_loss',
    detail: stopEvidence.gone ? native?.detail : 'cleanup_unverified',
    text: native?.text ?? execution.progress?.partialText ?? '', usage: native?.usage,
    nativeRefs: { historyId: execution.historyId, nativeTurnId: execution.nativeTurnId, ...native?.nativeRefs },
    selectedModel: execution.modelOverride, selectedEffort: execution.effortOverride, effectiveModel: native?.effectiveModel ?? execution.effectiveModel,
    effectiveEffort: native?.effectiveEffort ?? execution.effectiveEffort,
    stopEvidence, finishedAt: clock.now(),
  };
  records.writeResult(result, 'watcher');
  return records.readResult(execution.executionId);
}

export async function spawnCleanupWatcher({ stateDir, executionId }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), stateDir, executionId], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  await once(child, 'spawn');
  child.unref();
  return { pid: child.pid };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const records = new Records({ dir: process.argv[2] });
    const execution = records.readExecution(process.argv[3]);
    if (!execution) throw new Error('execution_not_found');
    const result = await cleanupExecution({ records, execution });
    if (!result?.stopEvidence?.gone) process.exitCode = 1;
  } catch (err) {
    console.error(`cleanup-watcher: ${err.code || err.message}`);
    process.exitCode = 1;
  }
}
