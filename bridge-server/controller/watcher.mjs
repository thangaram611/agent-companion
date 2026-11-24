import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { cleanupJob } from '../../scripts/cleanup-watcher.mjs';
import { Records } from './records.mjs';
import { logJob } from '../validation.mjs';

// A detached watcher has no stderr reader. Keep only a fixed failure code.
export async function runCleanup(options) {
  const { records, job } = options;
  let failure, host;
  try {
    host = records.readThread(job.thread)?.lead?.host;
    const result = await cleanupJob(options);
    if (result && !result.stopEvidence.gone) failure = 'cleanup_unverified';
    return result;
  } catch (err) {
    failure = 'watcher_cleanup_failed';
    throw err;
  } finally {
    if (failure) {
      logJob('watcher.failed', job, host, null, failure);
      const current = records.readJob(job.jobId);
      if (current?.writer === 'watcher') records.writeJob({ ...current, watcherFailure: failure }, 'watcher');
    }
  }
}

export async function spawnCleanupWatcher({ stateDir, jobId }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), stateDir, jobId], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  child.unref();
  return { pid: child.pid };
}

if (import.meta.main) {
  const [, , dir, jobId] = process.argv;
  let job;
  try {
    const records = new Records({ dir });
    job = records.readJob(jobId);
    if (!job) throw new Error('missing job record');
    const result = await runCleanup({ records, job });
    if (!result?.stopEvidence.gone) process.exitCode = 1;
  } catch {
    if (!job) logJob('watcher.failed', { jobId, thread: null }, null, null, 'watcher_input_unavailable');
    process.exitCode = 1;
  }
}
