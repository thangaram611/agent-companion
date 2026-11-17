// The live view's performance gate (docs/LIVE_VIEW_PLAN.md, Steps 2 and 3): a
// running job's JSONL grows to 10,000 transcript items, and every action is
// timed from the action to the frame Ink writes, once at a small transcript and
// again at 10,000 items. Ink renders to a fake TTY in interactive mode; keys go
// through Ink's stdin.
//
// The gate compares the two sizes in the same run, never milliseconds against a
// fixed budget: GitHub's runner with coverage took about 4x this Mac's frame
// times (append p95 39.9 ms against 8-9 ms here), so a fixed budget failed CI
// without any regression. Median at ~10,000 items over median at ~500, measured
// 2026-11-17 on Apple M-series, Node 26.13.1 (ranges over the runs shown):
//
//                                       append   single   key      type
//   current code, plain (3)             1.0-1.2  1.6      1.6      1.6-1.7
//   current, coverage (2)               1.1      1.5-1.6  1.5      1.5
//   current, coverage, slow cores (2)   1.2-1.8  1.5-2.0  1.5-1.9  1.4-1.6
//   re-read whole file per tick (2)     6.5-7.9  7.6-9.4  1.5-1.8  1.4-1.8
//   row cache never hits (2)            3.8-4.3  5.7-6.1  6.0-6.6  5.9-6.7
//
// Slow cores (taskpolicy -c background) ran about 7x slower than plain, slower
// than CI. Appending, scrolling and typing should not grow with the transcript:
// at most STEADY times slower, which both regressions exceed on several rows.
// Expand-all and resize touch every item, so they may grow linearly with the
// transcript but not faster (at most the size ratio, about 20); current code
// measured 1.1-3.5.
import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { codexItem, uiFixture } from '../../test/ui-fixture.mjs';
import { run } from './app.mjs';

const STEADY = 3;
const SMALL = 500, ITEMS = 10_000, BATCH = 50;

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

test(`performance gate: ${ITEMS} appended items, scroll, typing, resize, expand and collapse`, { timeout: 300_000 }, async t => {
  const f = uiFixture(t);
  const model = f.model({ size: { columns: 150, rows: 40 } });
  const stdout = new Terminal(150, 40);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let renders = 0, waiter = null;
  const { app } = run({ model, stdout, stdin, pollMs: 1e9, interactive: true, maxFps: 1000, patchConsole: false,
    onRender() { renders++; waiter?.(); waiter = null; } });
  t.after(() => app.unmount());
  // An action that changes nothing renders nothing: fail naming it, never hang.
  async function frame(action, label) {
    const before = renders, t0 = performance.now();
    action();
    if (renders === before) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame within 10 s after ${label}`)), 10_000);
      waiter = () => { clearTimeout(timer); resolve(); };
    });
    await app.waitUntilRenderFlush();
    return performance.now() - t0;
  }
  const key = sequence => frame(() => stdin.write(sequence), JSON.stringify(sequence));
  while (model.selected !== 'claude:run-1') await key('\x1b[B');
  // Focusing the running job focuses its message box.
  await key('\t');

  let appended = 0;
  async function grow(to) {
    const times = [];
    for (; appended < to; appended += BATCH) {
      f.append(items(appended, BATCH));
      times.push(await frame(() => model.tick(), 'append'));
    }
    return times;
  }
  // Every action at the transcript's current size; leaves the message box focused and empty.
  async function actions() {
    const m = { single: [], key: [], type: [], expand: [], resize: [] };
    // One item at a time: the live-follow case.
    for (let i = 0; i < 10; i++, appended++) {
      f.append(items(appended, 1));
      m.single.push(await frame(() => model.tick(), 'single append'));
    }
    for (let i = 0; i < 30; i++) m.key.push(await key('\x1b[A'));
    for (let i = 0; i < 10; i++) m.key.push(await key('\x1b[5~'));
    for (let i = 0; i < 10; i++) m.key.push(await key('\x1b[6~'));
    // Typing as a person does: characters, ctrl+j lines, backspaces and mode changes.
    const words = 'Keep the fake server; add an idle event after the step instead. ';
    for (let i = 0; i < 60; i++) m.type.push(await key(words[i % words.length]));
    for (let i = 0; i < 5; i++) m.type.push(await key('\n'), await key(words[i]));
    assert.equal(model.boxes.get('claude:run-1').draft.length, 70, 'every key reached the draft');
    for (let i = 0; i < 70; i++) m.type.push(await key('\x7f'));
    for (let i = 0; i < 3; i++) m.type.push(await key('\x1b[Z'));
    for (let i = 0; i < 4; i++) m.expand.push(await key('\x0f'));
    // Back to the list, where e and E work on the selected job and f toggles
    // following (e stops it), then back to the job's box. The live-follow case
    // needs following on before the transcript grows again.
    await key('\x1b');
    for (let i = 0; i < 12; i++) m.expand.push(await key(i % 4 === 3 ? 'E' : 'e'));
    if (!model.detail.follow) await key('f');
    assert.ok(model.detail.follow, 'following again');
    await key('\t');
    for (const [columns, rows] of [[100, 30], [200, 60], [90, 50], [150, 40]].flatMap(size => [size, size])) {
      m.resize.push(await frame(() => stdout.resize(columns, rows), `resize ${columns}x${rows}`));
    }
    return m;
  }

  const smallAppend = await grow(SMALL);
  const small = { append: smallAppend, ...await actions() };
  const smallSize = model.detail.list.length;
  const largeAppend = await grow(ITEMS);
  const large = { append: largeAppend.slice(-smallAppend.length), ...await actions() };
  const largeSize = model.detail.list.length;
  assert.ok(largeSize >= ITEMS, `${largeSize} items followed`);
  assert.match(model.render().flat().map(([text]) => text).join(''), new RegExp(`n${appended - 1}\\.mjs`));

  // Opening the same transcript cold replays it once (reported, not gated).
  const open = performance.now();
  const reopened = f.model({ size: { columns: 150, rows: 40 } });
  while (reopened.selected !== 'claude:run-1') reopened.key('', { downArrow: true });
  reopened.render();

  const limits = { append: STEADY, single: STEADY, key: STEADY, type: STEADY, expand: largeSize / smallSize, resize: largeSize / smallSize };
  const report = { items: { small: smallSize, large: largeSize }, open: { ms: +(performance.now() - open).toFixed(1), items: reopened.detail.list.length } };
  for (const name of Object.keys(limits)) {
    const before = stats(small[name]), after = stats(large[name]);
    report[name] = { small: before, large: after, ratio: +(after.p50 / before.p50).toFixed(2), limit: +limits[name].toFixed(1) };
  }
  t.diagnostic(JSON.stringify(report));
  for (const [name, { ratio, limit, small: before, large: after }] of Object.entries(report)) {
    if (ratio === undefined) continue;
    assert.ok(ratio <= limit, `${name}: median ${after.p50} ms at ${largeSize} items is ${ratio}x the ${before.p50} ms at ${smallSize}, over ${limit}x`);
  }
});
