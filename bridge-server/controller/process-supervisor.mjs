import { spawn as spawnChild, execFile } from 'node:child_process';
import { once } from 'node:events';
import { systemClock, delay } from './clock.mjs';

// POSIX ps supplies birth identity as well as ancestry. Never select by name.
export function readProcessTable(clock = systemClock) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      clock.clearTimeout(timer);
      if (err || timedOut) return reject(err || new Error('ps_timeout'));
      const rows = new Map();
      for (const line of stdout.split('\n').filter((line) => line.trim())) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s*$/);
        if (!match) return reject(new Error('unrecognized ps row'));
        const [, pid, ppid, pgid, birthTime, state] = match;
        rows.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), birthTime: birthTime.replace(/\s+/g, ' '), state });
      }
      resolve(rows);
    });
    const timer = clock.setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 1000);
  });
}
const identity = ({ pid, pgid, birthTime }) => ({ pid, pgid, birthTime });
const matches = (record, row) => Boolean(row && record.birthTime && record.birthTime === row.birthTime);

export class ProcessSupervisor {
  constructor({ record = null, clock = systemClock, onRecord = () => {}, processTable = () => readProcessTable(clock), signal = (pid, sig) => process.kill(pid, sig) } = {}) {
    this.clock = clock;
    this.onRecord = onRecord;
    this.processTable = processTable;
    this.signal = signal;
    this.record = structuredClone(record || { pid: null, pgid: null, birthTime: null, processes: [] });
    this.lastSignals = [];
    this.sealed = false;
    this.pending = new Set();
  }
  serialize() { return structuredClone(this.record); }
  _publish() { this.onRecord(this.serialize()); }
  async spawn(argv, opts = {}) {
    if (this.sealed || this.record.pid) throw new Error('runtime_already_started_or_closed');
    if (!Array.isArray(argv) || !argv.length) throw new Error('invalid argv');
    const child = this.child = spawnChild(argv[0], argv.slice(1), { ...opts, detached: true, shell: false });
    this.record.pid = child.pid ?? null;
    this.record.pgid = child.pid ?? null;
    this._publish();
    child.on('error', () => {}); // The spawn promise reports startup errors.
    child.once('exit', () => { this.exited = true; });
    this.starting = (async () => {
      await once(child, 'spawn');
      const table = await this.processTable();
      const row = table.get(child.pid);
      if (!row || this.exited) throw new Error('runtime_unavailable');
      this.record.birthTime = row.birthTime;
      this.record.processes.push(identity(row));
      this._publish();
      await this.census();
      if (!this.sealed) this._schedule();
      return child;
    })();
    return this.starting;
  }
  _schedule() {
    this.timer = this.clock.setTimeout(async () => {
      try { await this.census(); }
      catch (err) { this.record.censusError = err.message; this._publish(); }
      if (!this.sealed) this._schedule();
    }, 2000);
    this.timer?.unref?.();
  }
  _track(operation) {
    const promise = operation();
    this.pending.add(promise);
    const finished = () => this.pending.delete(promise);
    promise.then(finished, finished);
    return promise;
  }
  recordDescendant(pid) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || this.sealed) throw new Error('invalid descendant');
    return this._track(async () => {
      const row = (await this.processTable()).get(pid);
      if (!row) return false;
      this._remember(row); this._publish(); return true;
    });
  }
  _remember(row) {
    if (!this.record.processes.some((p) => p.pid === row.pid && p.birthTime === row.birthTime)) this.record.processes.push(identity(row));
  }
  census() { return this._track(() => this._census()); }
  async _census() {
    const table = await this.processTable();
    const owned = new Set(this.record.processes.filter((p) => matches(p, table.get(p.pid))).map((p) => p.pid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table.values()) {
        if (!owned.has(row.pid) && owned.has(row.ppid)) { owned.add(row.pid); this._remember(row); changed = true; }
      }
    }
    this._publish();
    return this.serialize();
  }
  stopCensus() { this.sealed = true; this.clock.clearTimeout(this.timer); }
  async quiesce() {
    this.stopCensus();
    await this.starting?.catch(() => {});
    await Promise.allSettled([...this.pending]);
  }
  // Leave the provider stdio alone until the watcher is spawned; then let the
  // host bridge exit without being held open by its ChildProcess handles.
  detach() {
    this.stopCensus();
    this.onRecord = () => {};
    this.child?.unref();
    for (const stream of this.child?.stdio || []) stream?.unref?.();
    this.child?.channel?.unref();
  }
  async verifyGone() {
    if (!this.record.pid && !this.record.processes.length) return { gone: true, survivors: [], checkedAt: this.clock.now() };
    try {
      const table = await this.processTable();
      const survivors = this.record.processes.filter((p) => matches(p, table.get(p.pid)));
      const unrecordedRoot = this.record.pid && !this.record.birthTime && !this.exited;
      return { gone: survivors.length === 0 && !unrecordedRoot, survivors, checkedAt: this.clock.now() };
    } catch (err) {
      return { gone: false, survivors: this.record.processes, checkedAt: this.clock.now(), error: err.message };
    }
  }
  async _signal(sig) {
    const table = await this.processTable();
    const living = this.record.processes.filter((p) => matches(p, table.get(p.pid)));
    const targets = living.map((p) => p.pid);
    if (living.some((p) => table.get(p.pid).pgid === this.record.pgid)) targets.unshift(-this.record.pgid);
    for (const pid of targets) {
      try { this.signal(pid, sig); this.lastSignals.push({ pid, signal: sig, at: this.clock.now() }); }
      catch (err) { if (err.code !== 'ESRCH') this.lastSignals.push({ pid, signal: sig, error: err.code || err.message }); }
    }
  }
  terminate({ graceMs = 2000 } = {}) {
    if (!this.terminating) this.terminating = this._terminate(graceMs);
    return this.terminating;
  }
  async _terminate(graceMs) {
    this.stopCensus();
    const startedAt = this.clock.now();
    try {
      await this.quiesce();
      if (!this.record.pid && !this.record.processes.length) return { gone: true, survivors: [], startedAt, finishedAt: this.clock.now(), signals: [] };
      // A failed spawn/ps still has a directly owned child handle. Signal that
      // handle only while Node has not observed exit; never infer its identity.
      if (this.child && !this.record.birthTime && !this.exited) this.child.kill('SIGKILL');
      await this.census();
      await this._signal('SIGTERM');
      if (!(await this.verifyGone()).gone && graceMs > 0) await delay(this.clock, graceMs);
      await this.census(); // Catch children created during the grace period.
      await this._signal('SIGKILL');
      let evidence = await this.verifyGone();
      for (let n = 0; !evidence.gone && n < 20; n++) {
        await delay(this.clock, 25);
        evidence = await this.verifyGone();
      }
      return { ...evidence, startedAt, finishedAt: this.clock.now(), signals: this.lastSignals };
    } catch (err) {
      return { gone: false, error: err.message, startedAt, finishedAt: this.clock.now(), signals: this.lastSignals };
    }
  }
}
