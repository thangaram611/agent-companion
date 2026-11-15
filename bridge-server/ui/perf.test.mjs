// The live view's performance gate (docs/LIVE_VIEW_PLAN.md, Step 2): 10,000
// transcript items appended to a running job's JSONL, then scrolling, resizing
// and expand/collapse, each timed from the action to the frame Ink writes.
// Ink renders to a fake TTY in interactive mode; keys go through Ink's stdin.
import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { codexItem, uiFixture } from '../../test/ui-fixture.mjs';
import { run } from './app.mjs';

// Milliseconds per frame. Measured 2026-11-15 on Apple M-series, Node 26.13.1,
// five runs: append p95 8.3–9.2, max 17.4–21.4; keys p95 7.8–9.1, max 16.9–21;
// resize (every item rewrapped) max 57–63; expand all max 37–51. The budget is
// about three times that for slower CI runners. Re-reading the whole 17 MB file
// on every append instead of following it measured append p95 27.1 ms: a failure.
export const BUDGET = {
  append: { p95: 25, max: 60 }, key: { p95: 25, max: 60 }, resize: { p95: 200, max: 200 }, expand: { p95: 120, max: 200 },
};
const ITEMS = 10_000, BATCH = 50;

class Terminal extends Writable {
  constructor(columns, rows) { super(); Object.assign(this, { columns, rows, isTTY: true }); }
  _write(chunk, encoding, done) { done(); }
  resize(columns, rows) { Object.assign(this, { columns, rows }); this.emit('resize'); }
}
function items(start, count) {
  const out = [];
  for (let i = start; i < start + count; i++) {
    const kind = i % 20;
    if (kind < 8) out.push(codexItem('turn-2', { type: 'AgentMessage', id: `a${i}`, content: [{ type: 'text', text: `Reply ${i}: ${'checking the renderer and its rows '.repeat(4)}\nSecond line of reply ${i}.` }] }));
    else if (kind < 14) out.push(codexItem('turn-2', { type: 'CommandExecution', id: `c${i}`, command: ['/bin/zsh', '-lc', `node --test case-${i}.test.mjs`], status: 'completed',
      exit_code: i % 7 ? 0 : 1, aggregated_output: Array.from({ length: 30 }, (_, n) => `case ${i} line ${n} ${'output '.repeat(6)}`).join('\n') }));
    else if (kind < 17) out.push(codexItem('turn-2', { type: 'Reasoning', id: `r${i}`, summary_text: [`Thinking about step ${i}.\nAnd its consequences.`] }));
    else out.push(codexItem('turn-2', { type: 'FileChange', id: `f${i}`, status: 'completed', changes: { [`/work/agent-companion/lib/m${i}.mjs`]: { type: 'update' }, [`/work/agent-companion/lib/n${i}.mjs`]: { type: 'add' } } }));
  }
  return out;
}
const stats = times => {
  const sorted = [...times].sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { frames: times.length, p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +sorted.at(-1).toFixed(1) };
};

test(`performance gate: ${ITEMS} appended items, scroll, resize, expand and collapse`, { timeout: 300_000 }, async t => {
  const f = uiFixture(t);
  const model = f.model({ size: { columns: 150, rows: 40 } });
  const stdout = new Terminal(150, 40);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let renders = 0, waiter = null;
  const { app } = run({ model, stdout, stdin, pollMs: 1e9, interactive: true, maxFps: 1000, patchConsole: false,
    onRender() { renders++; waiter?.(); waiter = null; } });
  t.after(() => app.unmount());
  async function frame(action) {
    const before = renders, t0 = performance.now();
    action();
    if (renders === before) await new Promise(resolve => { waiter = resolve; });
    await app.waitUntilRenderFlush();
    return performance.now() - t0;
  }
  const key = sequence => frame(() => stdin.write(sequence));
  while (model.selected !== 'claude:run-1') await key('\x1b[B');
  await key('\t');
  const measured = { append: [], key: [], resize: [], expand: [] };

  for (let i = 0; i < ITEMS; i += BATCH) {
    f.append(items(i, BATCH));
    measured.append.push(await frame(() => model.tick()));
  }
  // One item at a time once the transcript is large: the live-follow case.
  for (let i = ITEMS; i < ITEMS + 20; i++) {
    f.append(items(i, 1));
    measured.append.push(await frame(() => model.tick()));
  }
  assert.ok(model.detail.list.length >= ITEMS, `${model.detail.list.length} items followed`);
  assert.match(model.render().flat().map(([text]) => text).join(''), new RegExp(`n${ITEMS + 19}\\.mjs`));

  for (let i = 0; i < 100; i++) measured.key.push(await key('\x1b[A'));
  for (let i = 0; i < 40; i++) measured.key.push(await key('\x1b[5~'));
  for (let i = 0; i < 40; i++) measured.key.push(await key('\x1b[6~'));
  measured.key.push(await key('g'), await key('G'));

  for (const [columns, rows] of [[100, 30], [200, 60], [150, 40], [90, 50], [150, 40]].flatMap(size => [size, size])) {
    measured.resize.push(await frame(() => stdout.resize(columns, rows)));
  }
  for (let i = 0; i < 20; i++) measured.expand.push(await key(i % 4 === 3 ? 'E' : 'e'));
  for (let i = 0; i < 4; i++) measured.expand.push(await key('E'));

  // Opening the same transcript cold replays it once (not a frame budget).
  const open = performance.now();
  const reopened = f.model({ size: { columns: 150, rows: 40 } });
  while (reopened.selected !== 'claude:run-1') reopened.key('', { downArrow: true });
  reopened.render();
  const report = Object.fromEntries(Object.entries(measured).map(([name, times]) => [name, stats(times)]));
  report.open = { ms: +(performance.now() - open).toFixed(1), items: reopened.detail.list.length };
  t.diagnostic(JSON.stringify(report));
  for (const [name, budget] of Object.entries(BUDGET)) {
    assert.ok(report[name].p95 <= budget.p95 && report[name].max <= budget.max, `${name}: ${JSON.stringify(report[name])} over ${JSON.stringify(budget)}`);
  }
});
