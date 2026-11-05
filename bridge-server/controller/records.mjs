import { readFileSync, readdirSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_DIR } from '../../lib/state.mjs';
import { refuseRealHomeUnderTest } from '../../lib/host.mjs';
import { writePrivateFileAtomic } from '../../lib/runtime-paths.mjs';

const segment = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(id)) throw new Error('invalid record id');
  return id;
};
const error = (code) => Object.assign(new Error(code), { code });

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
  readLease(id) { return this.read('leases', id); }
  readResult(id) { return this.read('results', id); }
  listExecutions() {
    let files;
    try { files = readdirSync(join(this.dir, 'executions')); }
    catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    return files.filter((f) => f.endsWith('.json')).map((f) => this.readExecution(f.slice(0, -5)));
  }
  readLegacyHistory(owner) {
    const file = (suffix) => {
      try { return readFileSync(join(this.dir, 'threads', `${segment(owner)}.${suffix}`), 'utf8').trim(); }
      catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    };
    if (file('ambiguous')) throw error('AMBIGUOUS_HISTORY');
    return file('sid');
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
  begin({ owner, provider, cwd, modelOverride, historyId = null, executionId, text, now }, expectedGeneration) {
    return this._locked(owner, () => {
      const old = this.readConversation(owner);
      if ((old?.generation ?? 0) !== expectedGeneration) {
        this.log({ code: 'stale_generation', owner, generation: expectedGeneration, current: old?.generation });
        throw error('stale_generation');
      }
      if (old) {
        const execution = this.readExecution(old.executionId);
        const result = this.readResult(old.executionId);
        if (!(execution?.state === 'closed' && execution.cleanup?.gone) && !result?.stopEvidence?.gone) throw error('execution_unknown');
      }
      const generation = expectedGeneration + 1;
      if (this.readExecution(executionId)) throw error('execution_id_busy');
      const execution = { owner, executionId, generation, provider, cwd, text, modelOverride, state: 'starting', writer: 'controller', startedAt: now, processes: null };
      this._write('executions', executionId, execution);
      this._write('conversations', owner, { owner, generation, executionId, provider, cwd, modelOverride, historyId });
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
  writeLease(record) {
    return this._locked(record.owner, () => {
      if (!this._fenced(record)) return false;
      this._write('leases', record.executionId, record); return true;
    });
  }
  writeResult(record, writer = 'controller') {
    return this._locked(record.owner, () => {
      if (!this._fenced(record, writer) || this.readResult(record.executionId)) return false;
      if (!['completed', 'failed', 'interrupted', 'stopped', 'delivery_unknown'].includes(record.outcome)) throw error('invalid_outcome');
      if (record.outcome === 'stopped' && !record.stopEvidence?.gone) throw error('exit_unverified');
      this._write('results', record.executionId, record); return true;
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
