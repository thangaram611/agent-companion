import { readFileSync, readSync, readdirSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, lstatSync, fstatSync, rmSync, constants } from 'node:fs';
import { join } from 'node:path';
import { BASE_DIR } from '../../lib/state.mjs';
import { refuseRealHomeUnderTest } from '../../lib/hosts/index.mjs';
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
export function resultText(execution, fallback = execution.terminal?.text ?? execution.turns?.[0]?.text ?? execution.progress?.partialText ?? '') {
  if ((execution.turns?.length ?? 0) <= 1) return fallback;
  return execution.turns.map(turn => {
    const labels = turn.messages.map(id => {
      if (id === execution.executionId) return 'Task';
      const message = execution.interventions.find(input => input.id === id);
      return `${message.from === 'user' ? "User's" : "Caller's"} message (${message.mode === 'queue' ? 'queued' : message.mode}): ${firstLine(message.text)}`;
    });
    return `${labels.join('; ')}\n\n${turn.outcome === 'interrupted' ? 'interrupted before answering' : turn.text}`;
  }).join('\n\n');
}
// Adapters report each turn's own usage; a job's usage is their sum.
export const resultUsage = (execution, fallback = execution.terminal?.usage) =>
  (execution.turns?.length ?? 0) > 1 ? sumUsage(execution.turns.map(turn => turn.usage)) : fallback;

export function discardInterventions(execution) {
  for (const input of execution.interventions ?? []) {
    if (input.state !== 'answered') input.state = 'not_delivered';
  }
}

// All mutations take a per-conversation exclusive lock. No await occurs under
// it, so a generation check and rename cannot interleave with another writer.
// A lock left by a crash fails closed (RECORD_BUSY); never guess its ownership
// from a PID and steal it. Readers require neither a lock nor directory creation.
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
  readConversation(owner) { return this.read('conversations', owner); }
  readExecution(id) { return this.read('executions', id); }
  readAttachment(id) { return this.read('attachments', id); }
  readResult(id) { return this.read('results', id); }
  inboxPath(executionId) { return join(this.dir, 'inbox', segment(executionId)); }
  readInbox(executionId) {
    const dir = this.inboxPath(executionId);
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
        if (!request || request.requestId !== requestId || typeof request.executionId !== 'string'
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
  finishInbox(executionId, requestId, outcome) {
    const dir = this.inboxPath(executionId);
    // Close owns directory removal. A late native acknowledgement must not
    // recreate an inbox after its terminal result (including watcher close).
    if (this.readResult(executionId)) return;
    try {
      if (!lstatSync(dir).isDirectory()) return;
      writePrivateFileAtomic(join(dir, `${segment(requestId)}.outcome.json`), JSON.stringify({ requestId, ...outcome }) + '\n');
      rmSync(join(dir, `${segment(requestId)}.json`), { recursive: true, force: true });
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  removeInbox(executionId) { rmSync(this.inboxPath(executionId), { recursive: true, force: true }); }
  takeUserIntervention(executionId, owner) {
    // Notice receipts have a separate lifetime from runtime writer fencing:
    // a wait can acknowledge an old execution after close or bridge handoff.
    return this._locked(owner, () => {
      const execution = this.readExecution(executionId);
      if (!execution || execution.owner !== owner) throw error('execution_unknown');
      const reported = this.read('intervention-notices', executionId)?.reported ?? [];
      const input = execution.interventions?.find(input => input.from === 'user' && !reported.includes(input.id));
      if (!input) return null;
      this._write('intervention-notices', executionId, { reported: [...reported, input.id] });
      const { from, mode, text, at } = input;
      return { from, mode, text, at };
    });
  }
  listExecutions() {
    let files;
    try { files = readdirSync(join(this.dir, 'executions')); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return files.filter((f) => f.endsWith('.json')).map((f) => this.readExecution(f.slice(0, -5)));
  }
  readLegacyHistory(owner, provider) {
    const file = (suffix) => {
      try { return readFileSync(join(this.dir, 'threads', `${segment(owner)}.${suffix}`), 'utf8').trim(); }
      catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    };
    const conflict = file('ambiguous');
    if (conflict) throw Object.assign(error('AMBIGUOUS_HISTORY'), { message: `legacy thread ${owner} has conflicting histories: ${conflict}` });
    const sid = file('sid');
    if (!sid) return null;
    // A bare legacy sid has no provider identity. Adopt it only when the last
    // ledger job for this owner proves the same target; never silently reset.
    let files = [];
    try { files = readdirSync(join(this.dir, 'jobs')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const jobs = files.filter((f) => f.endsWith('.json')).map((f) => this.read('jobs', f.slice(0, -5)))
      .filter((job) => job?.thread === owner).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const latest = jobs[0];
    if (!latest?.target || latest.target !== provider) {
      throw Object.assign(error('thread_ambiguous'), {
        message: `legacy thread ${owner} belongs to ${latest?.target || 'an unknown target'}; requested ${provider}`,
      });
    }
    return sid;
  }
  readStop(owner) {
    const value = this.read('stops', owner);
    if (!value) return null;
    try {
      const stat = statSync(this.path('stops', owner));
      return { value, mtimeMs: stat.mtimeMs, ino: stat.ino };
    } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  _write(kind, id, data) {
    mkdirSync(join(this.dir, kind), { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(this.path(kind, id), JSON.stringify(data) + '\n');
  }
  _locked(owner, fn) {
    const dir = join(this.dir, 'locks');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, segment(owner) + '.lock');
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') throw error('RECORD_BUSY'); throw err; }
    try { return fn(); }
    finally { closeSync(fd); unlinkSync(path); }
  }
  _fenced(record, writer = 'controller') {
    const conversation = this.readConversation(record.owner);
    if (!conversation || conversation.generation !== record.generation) {
      this.log({ code: 'stale_generation', owner: record.owner, generation: record.generation, current: conversation?.generation });
      return false;
    }
    const execution = this.readExecution(conversation.executionId);
    if ((record.executionId && record.executionId !== conversation.executionId) || execution?.writer !== writer) {
      this.log({ code: 'writer_fenced', owner: record.owner, generation: record.generation });
      return false;
    }
    return true;
  }
  begin({ owner, provider, cwd, modelOverride, effortOverride, permissionMode, interventionModes, historyId = null, executionId, text, hostSessionId, now }, expectedGeneration) {
    return this._locked(owner, () => {
      const old = this.readConversation(owner);
      if ((old?.generation ?? 0) !== expectedGeneration) {
        this.log({ code: 'stale_generation', owner, generation: expectedGeneration, current: old?.generation });
        throw error('stale_generation');
      }
      if (old) {
        const execution = this.readExecution(old.executionId);
        const result = this.readResult(old.executionId);
        // The previous tree was never verified gone; a new provider process could
        // overlap it. Running elsewhere or closed without verified cleanup: a distinct refusal, not an unknown execution.
        if (!(execution?.state === 'closed' && execution.cleanup?.gone) && !result?.stopEvidence?.gone) throw error('previous_execution_unverified');
      }
      const generation = expectedGeneration + 1;
      if (this.readExecution(executionId)) throw error('execution_id_busy');
      const execution = { owner, executionId, generation, provider, cwd, text, modelOverride, effortOverride, permissionMode, hostSessionId, state: 'starting', writer: 'controller', startedAt: now, processes: null,
        interventionModes: { default: null, steer: false, queue: false, interrupt: false, ...interventionModes },
        interventions: [], turns: [], nativeTurnIds: [] };
      this._write('executions', executionId, execution);
      // Effort becomes a conversation override only after openHistory accepts it.
      this._write('conversations', owner, { owner, generation, executionId, provider, cwd, modelOverride, effortOverride: old?.effortOverride, historyId });
      return execution;
    });
  }
  writeConversation(record) {
    return this._locked(record.owner, () => {
      if (!this._fenced(record)) return false;
      this._write('conversations', record.owner, record); return true;
    });
  }
  writeExecution(record, writer = 'controller') {
    return this._locked(record.owner, () => {
      if (!this._fenced(record, writer)) return false;
      this._write('executions', record.executionId, record); return true;
    });
  }
  writeAttachment(record) {
    return this._locked(record.owner, () => {
      if (!this._fenced(record)) return false;
      this._write('attachments', record.executionId, record); return true;
    });
  }
  writeResult(record, writer = 'controller') {
    return this._locked(record.owner, () => {
      if (!this._fenced(record, writer) || this.readResult(record.executionId)) return false;
      if (!['completed', 'failed', 'interrupted', 'stopped', 'delivery_unknown'].includes(record.outcome)) throw error('invalid_outcome');
      if (record.outcome === 'stopped' && !record.stopEvidence?.gone) throw error('exit_unverified');
      this._write('results', record.executionId, record);
      this.removeInbox(record.executionId);
      return true;
    });
  }
  handoff(record) {
    return this._locked(record.owner, () => {
      if (!this._fenced(record)) return false;
      this._write('executions', record.executionId, { ...record, writer: 'watcher', state: 'cleanup_pending' });
      return true;
    });
  }
}
