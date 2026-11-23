import { SANDBOX_HOME } from '../sandbox-home.mjs';
import { mkdtempSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../bridge-server/controller/controller.mjs';
import { Records } from '../../bridge-server/controller/records.mjs';
import { setImmediate as yieldIO } from 'node:timers/promises';

export class ManualClock {
  time = 0;
  wall = 1_800_000_000_000;
  timers = new Map();
  serial = 0;
  now = () => this.wall + this.time;
  monotonic = () => this.time;
  setTimeout = (fn, ms) => {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      await this.flush();
      const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = Math.max(this.time, next[1].at);
      this.timers.delete(next[0]);
      next[1].fn();
    }
    this.time = end;
    await this.flush();
  }
  async suspend(ms) {
    this.time += ms;
    await this.advance(0);
  }
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Turn-loop assertions still need the final result after the caller has
// received its user-input notices. Notice shape/count tests call wait directly.
export async function waitForResult(controller, args) {
  let response;
  do { response = await controller.wait(args); }
  while (response.status === 'user_intervened');
  return response;
}

// Yield for actual child/ps I/O, never sleep for a lifecycle deadline. This
// watchdog bounds external I/O; iteration counts starve children under full
// suite load. All execution/lease/escalation timers still use ManualClock.
export async function until(predicate, label = 'condition') {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await yieldIO();
  }
  throw new Error(`Did not observe ${label}`);
}

export function fakeAdapter(options = {}) {
  let turnNumber = 0, pending = false;
  return {
    capabilities: { followUp: true, modelSelection: true, loadsHistory: true, ...options.capabilities },
    calls: [], terminal: deferred(), ack: deferred(),
    async start(args) {
      this.calls.push(['start', args]);
      if (options.startCrash) throw new Error('startup crash');
      if (options.start) return options.start(args);
      return { runtime: await args.supervisor.spawn(['fake'], { cwd: args.cwd }) };
    },
    async openHistory(args) {
      this.calls.push(['openHistory', args]);
      if (options.historyError) throw Object.assign(new Error(options.historyError), { code: options.historyError });
      if (options.historyCrash) throw new Error('HistoryUnavailable');
      return { historyId: args.historyId || 'native-history', effectiveModel: 'effective-model', ...options.history };
    },
    async deliver(args) {
      options.beforeSend?.(args.messageId);
      this.calls.push(['deliver', args]);
      if (options.lostAck) return this.ack.promise;
      if (turnNumber) this.terminal = deferred();
      turnNumber++;
      return options.ack ?? { nativeTurnId: `turn-${turnNumber}` };
    },
    observe(args) {
      this.calls.push(['observe', args]);
      this.progress = args.onProgress;
      this.onInput = args.onInput;
      return this.terminal.promise;
    },
    hasPendingInput() { return pending; },
    async steer({ id, text }) {
      options.beforeSend?.(id);
      this.calls.push(['steer', { id, text }]);
      return { accepted: true, confirmed: true, nativeTurnId: `turn-${turnNumber}` };
    },
    async intervene({ mode, id, text }) {
      options.beforeSend?.(id);
      this.calls.push([mode, { id, text }]);
      pending = true;
      return { accepted: true };
    },
    finishTurn(result, next) {
      const turn = this.terminal;
      if (next) this.terminal = deferred();
      pending = next;
      turn.resolve(result.messages ? { ...result, nativeTurnId: `turn-${++turnNumber}` } : result);
    },
    async interrupt() {
      this.calls.push(['interrupt']);
      if (options.interrupt) return options.interrupt();
      if (options.racingComplete) this.terminal.resolve({ outcome: 'completed', text: 'native answer', usage: { tokens: 7 } });
      if (options.hungInterrupt) return new Promise(() => {});
      if (options.interruptResult) this.terminal.resolve(options.interruptResult);
    },
    async close() {
      this.calls.push(['close']);
      if (options.hungClose) return new Promise(() => {});
    },
  };
}

export function setupController(options = {}) {
  const clock = new ManualClock();
  const dir = options.dir ?? mkdtempSync(join(SANDBOX_HOME, 'controller-'));
  const records = new Records({ dir, log() {} });
  const adapters = [], supervisors = [];
  const provider = options.provider ?? 'fake';
  const create = () => {
    const adapter = options.adapter ?? fakeAdapter(options);
    adapters.push(adapter);
    return adapter;
  };
  const createSupervisor = (args) => {
    const supervisor = options.createSupervisor?.(args) ?? {
      spawn: async () => ({}), serialize: () => ({ processes: [] }), census: async () => {},
      quiesce: async () => {}, stopCensus() {}, detach() {}, terminated: 0,
      async terminate() {
        this.terminated++;
        options.onTerminate?.();
        return { gone: options.gone ?? true, signals: [], checkedAt: clock.now() };
      },
    };
    supervisors.push(supervisor);
    return supervisor;
  };
  const config = { records, clock, createSupervisor, env: options.env ?? {},
    providers: { [provider]: { enabled: true, ready: true, modelAllowed: model => ['a', 'b'].includes(model), create } },
    snapshot: options.snapshot ?? (async () => ({ available: false, reason: 'test_non_git' })),
    launchWatcher: options.launchWatcher ?? (async () => ({ pid: 123 })),
  };
  const controller = options.createController ? options.createController(config) : new Controller(config);
  const send = (overrides = {}) => controller.send({ owner: 'child', provider, cwd: dir, text: 'verbatim text\nwith context', ...overrides });
  const done = async (executionId) => {
    await clock.flush();
    return controller.wait({ owner: records.readExecution(executionId).owner, executionId });
  };
  const finish = async (executionId, outcome = { outcome: 'completed', text: 'answer' }, adapter = adapters[0]) => {
    adapter.terminal.resolve(outcome); return done(executionId);
  };
  return { controller, clock, records, dir, adapters, supervisors, send, done, finish };
}

export function diskSnapshot(dir = SANDBOX_HOME) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).sort().filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => [f, statSync(join(dir, f)).mtimeMs, readFileSync(join(dir, f), 'base64')]);
}
