import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pane, clean, cut, itemLines, layoutLine, segsWidth, width } from './rows.mjs';

const text = rows => rows.map(row => row.map(([t]) => t).join(''));

test('clean removes terminal escapes, bidi overrides and controls; keeps the last carriage-return overwrite', () => {
  const plain = 'plain text, unchanged';
  assert.equal(clean(plain), plain);
  assert.equal(clean('\x1b[31mred\x1b[0m \x1b]0;title\x07ok\x1b(B'), 'red ok');
  assert.equal(clean('a\u202eb\u2066c\x07d'), 'abcd');
  assert.equal(clean('10%\r50%\r100%\nnext\ttab'), '100%\nnext    tab');
  assert.equal(clean(null), '');
});

test('width counts wide characters as two cells and marks as zero; cut stays within the width', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('日本'), 4);
  assert.equal(width('e\u0301'), 1);
  assert.equal(cut('日本語テキスト', 5), '日本…');
  assert.ok(width(cut('日本語テキスト', 5)) <= 5);
  assert.equal(cut('short', 10), 'short');
});

test('layoutLine wraps at spaces with a hanging indent, splits long words, aligns the right part, and never exceeds the width', () => {
  const rows = layoutLine({ segs: [['$ ', 'title'], ['node --test lib/digest.test.mjs and more arguments', 'title']], hang: 2, right: [['exit 1', 'bad']] }, 30);
  assert.deepEqual(text(rows), ['$ node --test           exit 1', '  lib/digest.test.mjs and more', '  arguments']);
  for (const w of [3, 7, 30]) {
    for (const row of layoutLine({ segs: [['x'.repeat(50) + ' 日本語のテキスト ' + 'y'.repeat(9), 'normal']], indent: 1, hang: 1 }, w)) assert.ok(segsWidth(row) <= w, `${w}: ${text([row])}`);
  }
  assert.deepEqual(text(layoutLine({ segs: [['a long line that is cut', 'dim']], wrap: false, right: [['+3', 'faint']] }, 16)), ['a long line…  +3']);
});

test('items fold output to its first and last lines with a count, and expand in full', () => {
  const item = { kind: 'command', command: ['/bin/zsh', '-lc', 'ls'], exitCode: 0, output: Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') };
  const folded = text(itemLines(item).flatMap(line => layoutLine(line, 40)));
  assert.deepEqual(folded, ['$ ls' + ' '.repeat(34) + 'ok', '  line 0', '  line 1', '  +6 lines', '  line 8', '  line 9']);
  assert.equal(itemLines(item, { expanded: true }).length, 11);
  assert.deepEqual(text(itemLines({ kind: 'command', command: 'sleep 9', status: 'running' }, { ended: true }).flatMap(line => layoutLine(line, 21))), ['$ sleep 9  unfinished']);
});

test('the pane rebuilds only changed blocks and slices visible rows across blocks', () => {
  const pane = new Pane();
  let built = 0;
  const block = (key, source, n) => ({ key, source, flags: '', lines: () => { built++; return Array.from({ length: n }, (_, i) => ({ segs: [[`${key}${i}`, 'normal']] })); } });
  const a = {}, b = {};
  assert.equal(pane.layout([block('a', a, 3), block('b', b, 2)], 10), 5);
  assert.equal(built, 2);
  pane.layout([block('a', a, 3), block('b', b, 2), block('c', {}, 4)], 10);
  assert.equal(built, 3, 'unchanged blocks reuse their rows');
  assert.deepEqual(pane.slice(2, 4).map(({ row }) => text([row])[0]), ['a2', 'b0', 'b1', 'c0']);
  assert.equal(pane.blockAt(5), 2);
  pane.layout([block('a', a, 3)], 12);
  assert.equal(built, 4, 'a new width rebuilds');
});

test('a refused command counts as refused, not also as failed', async () => {
  const { outcomeLines } = await import('./rows.mjs');
  const job = { execution: { startedAt: 0, cwd: '/w' }, result: { outcome: 'completed', finishedAt: 5000, text: 'done',
    workSummary: { commands: [{ command: 'rm -rf x', status: 'failed', exitCode: null, denied: 'Denied by user (*)' }, { command: 'false', exitCode: 1 }] } } };
  const first = outcomeLines(job)[0].segs.map(([t]) => t).join('');
  assert.equal(first, '✓ done in 0:05  2 commands, 1 failed, 1 refused');
});
