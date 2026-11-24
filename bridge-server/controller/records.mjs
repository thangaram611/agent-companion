import { readFileSync, readSync, readdirSync, mkdirSync, openSync, closeSync, unlinkSync, lstatSync, fstatSync, rmSync, constants } from 'node:fs';
import { join } from 'node:path';
import { logJob } from '../validation.mjs';
import { BASE_DIR } from '../../lib/state.mjs';
import { refuseRealHomeUnderTest, stateDirs } from '../../lib/hosts/index.mjs';
import { writePrivateFileAtomic } from '../../lib/runtime-paths.mjs';
import { sumUsage } from '../../lib/usage.mjs';
import { COMPANIONS } from '../../lib/companion-registry.mjs';

const companionName = (companion) => COMPANIONS[companion]?.shortName ?? companion;

const segment = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id)) throw new Error('invalid record id');
  return id;
};
const error = (code) => Object.assign(new Error(code), { code });

export const firstLine = text => { const line = text.split(/\r?\n/)[0]; return line.length > 80 ? `${line.slice(0, 79)}…` : line; };
// The same projections are used by normal close, recovery and the cleanup watcher.
// One turn needs no labels; several list each answer once, labelled for the
// caller, who reads the result: its own messages and the user's.
export function resultText(job, fallback = job.terminal?.text ?? job.turns?.[0]?.text ?? job.progress?.partialText ?? '') {
  if ((job.turns?.length ?? 0) <= 1) return fallback;
  return job.turns.map(turn => {
    const labels = turn.messages.map(id => {
      if (id === job.jobId) return 'Task';
      const message = job.interventions.find(input => input.id === id);
      return `${message.from === 'user' ? "User's" : "Caller's"} message (${message.mode === 'queue' ? 'queued' : message.mode}): ${firstLine(message.text)}`;
    });
    return `${labels.join('; ')}\n\n${turn.outcome === 'interrupted' ? 'interrupted before answering' : turn.text}`;
  }).join('\n\n');
}
// Adapters report each turn's own usage; a job's usage is their sum.
export const resultUsage = (job, fallback = job.terminal?.usage) =>
  (job.turns?.length ?? 0) > 1 ? sumUsage(job.turns.map(turn => turn.usage)) : fallback;

// The one result shape, for normal close, recovery and the cleanup watcher;
// each passes only how its job ended.
export function buildResult(job, { outcome, cause, detail, workSummary, stopEvidence, finishedAt }) {
  const { thread, jobId, companion, generation, turns, interventions, nativeTurnIds, terminal } = job;
  return {
    workSummary, thread, jobId, companion, generation, outcome, cause, detail, text: resultText(job),
    turns, interventions, nativeTurnIds, usage: resultUsage(job),
    nativeRefs: { historyId: job.historyId, nativeTurnId: job.nativeTurnId, nativeTurnIds, ...job.nativeRefs, ...terminal?.nativeRefs },
    selectedModel: job.modelOverride, selectedEffort: job.effortOverride,
    effectiveModel: terminal?.effectiveModel ?? job.effectiveModel, effectiveEffort: terminal?.effectiveEffort ?? job.effectiveEffort,
    stopEvidence, finishedAt,
  };
}

export function discardInterventions(job) {
  for (const input of job.interventions ?? []) {
    if (input.state !== 'answered') input.state = 'not_delivered';
  }
}

// Record mutations take a per-thread exclusive lock. No await occurs under
// it, so a generation check and rename cannot interleave with another writer.
// A lock left by a crash fails closed (RECORD_BUSY); never guess its ownership
// from a PID and steal it. Normal reads require neither a lock nor directory creation.
export class Records {
  constructor({ dir = BASE_DIR, log = (event) => console.error(JSON.stringify(event)) } = {}) {
    this.dir = refuseRealHomeUnderTest(dir, 'controller state dir');
    this.log = log;
  }
  path(kind, id) { return join(this.dir, kind, `${segment(id)}.json`); }
  read(kind, id) {
    try { return JSON.parse(readFileSync(this.path(kind, id), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  readThread(thread) { return this.read('threads', thread); }
  readJob(id) { return this.read('jobs', id); }
  readResult(id) { return this.read('results', id); }
  inboxPath(jobId) { return join(this.dir, 'inbox', segment(jobId)); }
  readInbox(jobId) {
    const dir = this.inboxPath(jobId);
    let files;
    try {
      if (!lstatSync(dir).isDirectory()) return [];
      files = readdirSync(dir).sort();
    } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return files.filter(name => /^[a-zA-Z0-9_-][a-zA-Z0-9._-]*\.json$/.test(name) && !name.endsWith('.outcome.json')).map(name => {
      const requestId = name.slice(0, -5);
      let fd;
      try {
        // Do not follow links or block on FIFOs. Both the metadata and read
        // are for this descriptor, and growth after stat still has a byte cap.
        fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw error('invalid_file');
        const limit = 64 * 1024;
        if (stat.size > limit) throw error('request_too_large');
        const buffer = Buffer.alloc(limit + 1);
        let size = 0, count;
        while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null))) size += count;
        if (size > limit) throw error('request_too_large');
        const request = JSON.parse(buffer.toString('utf8', 0, size));
        if (!request || request.requestId !== requestId || typeof request.jobId !== 'string'
          || !['steer', 'queue', 'interrupt', 'cancel'].includes(request.mode) || !Number.isFinite(request.at)
          || (request.mode === 'cancel' ? request.text !== undefined : typeof request.text !== 'string' || !request.text.length)) throw error('invalid_request');
        if (request.text?.length > 8000) throw error('text_too_long');
        return { requestId, request };
      } catch (err) {
        const reason = ['request_too_large', 'text_too_long', 'invalid_request'].includes(err.code) ? err.code
          : err instanceof SyntaxError ? 'invalid_request' : 'invalid_file';
        return { requestId, reason };
      } finally { if (fd !== undefined) closeSync(fd); }
    });
  }
  finishInbox(jobId, requestId, outcome) {
    const dir = this.inboxPath(jobId);
    // Close owns directory removal. A late native acknowledgement must not
    // recreate an inbox after its terminal result (including watcher close).
    if (this.readResult(jobId)) return;
    try {
      if (!lstatSync(dir).isDirectory()) return;
      writePrivateFileAtomic(join(dir, `${segment(requestId)}.outcome.json`), JSON.stringify({ requestId, ...outcome }) + '\n');
      rmSync(join(dir, `${segment(requestId)}.json`), { recursive: true, force: true });
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  removeInbox(jobId) { rmSync(this.inboxPath(jobId), { recursive: true, force: true }); }
  takeUserIntervention(jobId, thread) {
    // Notice receipts have a separate lifetime from runtime writer fencing:
    // a wait can acknowledge an old job after close or bridge handoff.
    return this._locked(thread, () => {
      const job = this.readJob(jobId);
      if (!job || job.thread !== thread) throw error('job_unknown');
      const reported = this.read('intervention-notices', jobId)?.reported ?? [];
      const input = job.interventions?.find(input => input.from === 'user' && !reported.includes(input.id));
      if (!input) return null;
      this._write('intervention-notices', jobId, { reported: [...reported, input.id] });
      const { from, mode, text, at } = input;
      return { from, mode, text, at };
    });
  }
  list(kind) {
    let files;
    try { files = readdirSync(join(this.dir, kind)); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return files.filter(f => f.endsWith('.json')).map(f => this.read(kind, f.slice(0, -5)));
  }
  listJobs() { return this.list('jobs'); }
  listThreads() { return this.list('threads'); }
  _write(kind, id, data) {
    mkdirSync(join(this.dir, kind), { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(this.path(kind, id), JSON.stringify(data) + '\n');
  }
  _locked(thread, fn) {
    const dir = join(this.dir, 'locks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, segment(thread) + '.lock');
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') throw error('RECORD_BUSY'); throw err; }
    try { return fn(); }
    finally { closeSync(fd); unlinkSync(path); }
  }
  _fenced(record, writer = 'controller') {
    const threadRecord = this.readThread(record.thread);
    if (!threadRecord || threadRecord.generation !== record.generation) {
      this.log({ code: 'stale_generation', thread: record.thread, generation: record.generation, current: threadRecord?.generation });
      return false;
    }
    const job = this.readJob(threadRecord.jobId);
    if ((record.jobId && record.jobId !== threadRecord.jobId) || job?.writer !== writer) {
      this.log({ code: 'writer_fenced', thread: record.thread, generation: record.generation });
      return false;
    }
    return true;
  }
  begin({ thread, lead, title, companion, cwd, modelOverride, effortOverride, permissionMode, interventionModes, historyId = null, jobId, text, hostSessionId, now }, expectedGeneration) {
    return this._locked(thread, () => {
      const old = this.readThread(thread);
      if ((old?.generation ?? 0) !== expectedGeneration) {
        this.log({ code: 'stale_generation', thread, generation: expectedGeneration, current: old?.generation });
        throw error('stale_generation');
      }
      if (old) {
        const job = this.readJob(old.jobId);
        const result = this.readResult(old.jobId);
        // The previous tree was never verified gone; a new companion process could
        // overlap it. Running elsewhere or closed without verified cleanup: a distinct refusal, not an unknown job.
        if (!(job?.state === 'closed' && job.cleanup?.gone) && !result?.stopEvidence?.gone) throw error('previous_job_unverified');
      }
      const generation = expectedGeneration + 1;
      if (this.readJob(jobId)) throw error('job_id_busy');
      const job = { thread, jobId, generation, companion, companionName: companionName(companion), cwd, text, modelOverride, effortOverride, permissionMode, hostSessionId, state: 'starting', writer: 'controller', startedAt: now, processes: null,
        interventionModes: { default: null, steer: false, queue: false, interrupt: false, ...interventionModes },
        interventions: [], turns: [], nativeTurnIds: [] };
      this._write('jobs', jobId, job);
      // A requested selection becomes a thread override only after openHistory accepts it.
      this._write('threads', thread, { thread, lead: old ? old.lead : lead, title: old ? old.title : title ?? firstLine(text),
        generation, jobId, companion, cwd, modelOverride: old?.modelOverride, effortOverride: old?.effortOverride, historyId });
      logJob('job.start', job, (old?.lead ?? lead)?.host, null, 'starting');
      return job;
    });
  }
  writeThread(record) {
    return this._locked(record.thread, () => {
      if (!this._fenced(record)) return false;
      this._write('threads', record.thread, record); return true;
    });
  }
  writeJob(record, writer = 'controller') {
    return this._locked(record.thread, () => {
      if (!this._fenced(record, writer)) return false;
      this._write('jobs', record.jobId, record); return true;
    });
  }
  writeResult(record, writer = 'controller') {
    return this._locked(record.thread, () => {
      if (!this._fenced(record, writer) || this.readResult(record.jobId)) return false;
      if (!['completed', 'failed', 'interrupted', 'stopped', 'delivery_unknown'].includes(record.outcome)) throw error('invalid_outcome');
      if (record.outcome === 'stopped' && !record.stopEvidence?.gone) throw error('exit_unverified');
      this._write('results', record.jobId, record);
      logJob('job.end', record, this.readThread(record.thread)?.lead?.host, null, record.outcome);
      this.removeInbox(record.jobId);
      return true;
    });
  }
  handoff(record) {
    return this._locked(record.thread, () => {
      if (!this._fenced(record)) return false;
      this._write('jobs', record.jobId, { ...record, writer: 'watcher', state: 'cleanup_pending' });
      return true;
    });
  }
}

export function isCompanionSession(session, env) {
  for (const { dir } of stateDirs(env)) {
    const records = new Records({ dir });
    let entries;
    try { entries = readdirSync(join(dir, 'threads'), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        if (records.readThread(entry.name.slice(0, -5))?.historyId === session) return true;
      } catch { /* Skip unreadable records and continue checking this host. */ }
    }
  }
  return false;
}
