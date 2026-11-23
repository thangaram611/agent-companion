import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirs } from '../lib/hosts/index.mjs';
import { modelName } from '../lib/model-name.mjs';
import { TARGET_IDS } from '../lib/target-registry.mjs';
import { Records } from './controller/records.mjs';

// OpenCode reports its model as { providerID, id, variant }: named as every view names it.
function reported(run, key) {
  return [run.terminal?.[key], run.progress?.[key], run[key]]
    .map(value => key === 'effectiveModel' ? modelName(value) : value)
    .find(value => typeof value === 'string' && value.trim()) ?? null;
}

// The CLI shows one run. The catalog can cite different runs for model and effort.
export function lastRuns(env, warnings) {
  const latest = new Map();
  const now = Date.now();
  for (const { host, dir } of stateDirs(env)) {
    const records = new Records({ dir });
    let files;
    try { files = readdirSync(join(dir, 'executions'), { withFileTypes: true }); }
    catch (err) {
      if (err.code !== 'ENOENT') warnings?.push(host + ' execution records: ' + err.code);
      continue;
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      let run;
      try { run = records.readExecution(file.name.slice(0, -5)); }
      catch (err) {
        warnings?.push(host + ' execution record ' + file.name + ': ' + (err.code || 'invalid record'));
        continue;
      }
      const { provider, startedAt } = run ?? {};
      if (!TARGET_IDS.has(provider) || typeof startedAt !== 'number' || !Number.isFinite(new Date(startedAt).getTime())) continue;
      const model = reported(run, 'effectiveModel');
      const effort = reported(run, 'effectiveEffort');
      if (!model && !effort) continue;
      const report = { model, effort, source: 'last run', host, startedAt, ageMs: Math.max(0, now - startedAt) };
      const entry = latest.get(provider) ?? {};
      const newerThan = previous => !previous || startedAt > previous.startedAt;
      if (newerThan(entry.run)) entry.run = report;
      if (model && newerThan(entry.model)) entry.model = report;
      if (effort && newerThan(entry.effort)) entry.effort = report;
      latest.set(provider, entry);
    }
  }
  return latest;
}
