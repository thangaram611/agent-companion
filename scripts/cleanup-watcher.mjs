import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Records, buildResult, discardInterventions } from '../bridge-server/controller/records.mjs';
import { ProcessSupervisor } from '../bridge-server/controller/process-supervisor.mjs';
import { systemClock } from '../bridge-server/controller/clock.mjs';

// The watcher owns no provider protocol and can never resume or deliver work.
// Its only durable write is the fenced, immutable result for this job.
export async function cleanupJob({ job, records = new Records(), clock = systemClock, createSupervisor = (opts) => new ProcessSupervisor(opts) }) {
  const threadRecord = records.readThread(job.thread);
  const current = records.readJob(job.jobId);
  if (threadRecord?.generation !== job.generation || current?.writer !== 'watcher') {
    records.log({ code: 'stale_generation', thread: job.thread, generation: job.generation });
    return null;
  }
  const supervisor = createSupervisor({ record: job.processes, clock });
  const stopEvidence = await supervisor.terminate();
  const native = job.terminal;
  discardInterventions(job);
  const result = buildResult(job, {
    outcome: native?.outcome || (stopEvidence.gone ? 'stopped' : 'failed'), cause: 'bridge_loss',
    detail: stopEvidence.gone ? native?.detail : 'cleanup_unverified', stopEvidence, finishedAt: clock.now(),
  });
  records.writeResult(result, 'watcher');
  return records.readResult(job.jobId);
}

export async function spawnCleanupWatcher({ stateDir, jobId }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), stateDir, jobId], {
    detached: true, stdio: 'ignore', env: process.env,
  });
  await once(child, 'spawn');
  child.unref();
  return { pid: child.pid };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const records = new Records({ dir: process.argv[2] });
    const job = records.readJob(process.argv[3]);
    if (!job) throw new Error('execution_not_found');
    const result = await cleanupJob({ records, job });
    if (!result?.stopEvidence?.gone) process.exitCode = 1;
  } catch (err) {
    console.error(`cleanup-watcher: ${err.code || err.message}`);
    process.exitCode = 1;
  }
}
