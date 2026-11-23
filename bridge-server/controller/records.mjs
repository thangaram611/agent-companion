import { readFileSync, readSync, readdirSync, mkdirSync, openSync, closeSync, unlinkSync, lstatSync, fstatSync, rmSync, rmdirSync, renameSync, existsSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASE_DIR } from '../../lib/state.mjs';
import { refuseRealHomeUnderTest, stateDirs } from '../../lib/hosts/index.mjs';
import { writePrivateFileAtomic } from '../../lib/runtime-paths.mjs';
import { sumUsage } from '../../lib/usage.mjs';

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

const migrated = new Set();

function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

function readMigrationRecord(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch (err) {
    // A peer can have moved the file. Keep damaged input for inspection.
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

const tolerate = (fn, codes) => { try { fn(); } catch (err) { if (!codes.includes(err.code)) throw err; } };

// A 1.0.0 store can still hold 0.x threads/ and jobs/, which the new folders would collide with. The process
// whose mkdir claims legacy.pending/ moves the 0.x leftovers into it, then renames it to legacy/: that atomic
// rename marks the archive complete, and no process writes threads/ or jobs/ before it. Others wait for it; one
// that has not finished in five seconds died, and its moves are safe to finish, since every move tolerates a peer's.
function archiveLegacy(dir) {
  const legacy = join(dir, 'legacy'), pending = join(dir, 'legacy.pending');
  let claimed = false;
  tolerate(() => { mkdirSync(pending, { mode: 0o700 }); claimed = true; }, ['EEXIST']);
  if (!claimed) {
    const deadline = Date.now() + 5000;
    while (!existsSync(legacy) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (existsSync(legacy)) return;
  }
  for (const { name } of entries(dir)) {
    if (/^(threads|jobs|attachments|completions|leases|stops|phase1-migrated|daemon\.log)$/.test(name) || name.startsWith('profiles.retired-'))
      tolerate(() => renameSync(join(dir, name), join(pending, name)), ['ENOENT', 'ENOTEMPTY', 'EEXIST']);
  }
  tolerate(() => renameSync(pending, legacy), ['ENOENT', 'ENOTEMPTY', 'EEXIST']);
}

function migrateRecords(dir) {
  dir = resolve(dir);
  if (migrated.has(dir)) return;
  if (lstatSync(join(dir, 'conversations'), { throwIfNoEntry: false })?.isDirectory() && !existsSync(join(dir, 'legacy'))) archiveLegacy(dir);

  for (const [source, destination] of [['conversations', 'threads'], ['executions', 'jobs'], ['results', 'results']]) {
    const from = join(dir, source), to = join(dir, destination);
    if (!lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) continue;
    const inPlace = from === to;
    for (const file of entries(from)) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const path = join(from, file.name), dest = join(to, file.name);
      // The migration removes each old file it copies, so one found later was written afterwards by a bridge still
      // running 1.0.0 code, and its copy wins. A new record newer than the old file means an earlier run died
      // between its write and the removal.
      const moved = lstatSync(path, { throwIfNoEntry: false }), existing = lstatSync(dest, { throwIfNoEntry: false });
      if (!moved) continue;
      if (inPlace || !existing || existing.mtimeMs <= moved.mtimeMs) {
        const data = readMigrationRecord(path);
        if (!data || (inPlace && Object.hasOwn(data, 'jobId'))) continue;
        const { owner, executionId, provider, ...record } = data;
        record.thread ??= owner;
        record.jobId ??= executionId ?? (inPlace ? file.name.slice(0, -5) : undefined);
        record.companion ??= provider;
        // Normal 1.0.0 results got their companion from the job.
        if (inPlace && !record.companion) record.companion = readMigrationRecord(join(dir, 'jobs', file.name))?.companion;
        for (const terminal of [record, record.terminal]) {
          if (terminal?.cause === 'provider_error') terminal.cause = 'companion_error';
          if (terminal?.detail === 'provider_error') terminal.detail = 'companion_error';
        }
        mkdirSync(to, { recursive: true, mode: 0o700 });
        writePrivateFileAtomic(dest, JSON.stringify(record) + '\n', { replace: true });
      }
      if (!inPlace) rmSync(path, { force: true });
    }
    if (!inPlace) {
      try { rmdirSync(from); }
      catch (err) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err; }
    }
  }
  migrated.add(dir);
}

// After migration, record mutations take a per-thread exclusive lock. No await occurs under
// it, so a generation check and rename cannot interleave with another writer.
// A lock left by a crash fails closed (RECORD_BUSY); never guess its ownership
// from a PID and steal it. Normal reads require neither a lock nor directory creation.
export class Records {
  constructor({ dir = BASE_DIR, log = (event) => console.error(JSON.stringify(event)) } = {}) {
    this.dir = refuseRealHomeUnderTest(dir, 'controller state dir');
    this.log = log;
    migrateRecords(this.dir);
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
      if (!job || job.thread !== thread) throw error('execution_unknown');
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
        if (!(job?.state === 'closed' && job.cleanup?.gone) && !result?.stopEvidence?.gone) throw error('previous_execution_unverified');
      }
      const generation = expectedGeneration + 1;
      if (this.readJob(jobId)) throw error('execution_id_busy');
      const job = { thread, jobId, generation, companion, cwd, text, modelOverride, effortOverride, permissionMode, hostSessionId, state: 'starting', writer: 'controller', startedAt: now, processes: null,
        interventionModes: { default: null, steer: false, queue: false, interrupt: false, ...interventionModes },
        interventions: [], turns: [], nativeTurnIds: [] };
      this._write('jobs', jobId, job);
      // Effort becomes a thread override only after openHistory accepts it.
      this._write('threads', thread, { thread, lead: old ? old.lead : lead, title: old ? old.title : title ?? firstLine(text),
        generation, jobId, companion, cwd, modelOverride, effortOverride: old?.effortOverride, historyId });
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
