import '../sandbox-home.mjs';
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
