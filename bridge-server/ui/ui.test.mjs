import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToString } from 'ink';
import { Screen } from './app.mjs';
import { codexItem, uiFixture } from '../../test/ui-fixture.mjs';

const RAW = { serializers: [value => value] };
const plain = text => text.replace(/\x1b\[[0-9;]*m/g, '');
const screen = model => plain(renderToString(h(Screen, { model }), { columns: model.size.columns }));
const press = (model, ...keys) => {
  for (const key of keys) model.key(key.length === 1 ? key : '', key.length === 1 ? {} : { [key]: true });
};
function open(f, key, columns, rows = 26) {
  const model = f.model({ size: { columns, rows } });
  while (model.selected !== key) press(model, 'downArrow');
  if (columns < 110) press(model, 'return');
  return model;
}

for (const columns of [150, 80]) {
  for (const [name, key] of [['running', 'claude:run-1'], ['finished', 'claude:done-1'], ['failed', 'codex:fail-1']]) {
    test(`${name} job at ${columns} columns`, t => {
      const text = screen(open(uiFixture(t), key, columns));
      for (const row of text.split('\n')) assert.ok(row.length <= columns, row);
      t.assert.snapshot(text, RAW);
    });
  }
}
test('job list at 80 columns', t => t.assert.snapshot(screen(uiFixture(t).model({ size: { columns: 80, rows: 26 } })), RAW));

test('narrow: Enter opens the job full width, Esc returns; resizing keeps it open', t => {
  const model = uiFixture(t).model({ size: { columns: 80, rows: 26 } });
  press(model, 'downArrow', 'return');
  assert.match(screen(model), /Claude Code › Live view plan · gpt-6-astra high · main/);
  assert.doesNotMatch(screen(model), /Restore spec triage/);
  model.setSize({ columns: 150, rows: 26 });
  assert.match(screen(model), /Restore spec triage[\s\S]*│▎/, 'the list returns beside the focused transcript');
  model.setSize({ columns: 80, rows: 26 });
  press(model, 'escape');
  assert.match(screen(model), /Restore spec triage/);
});

test('any terminal size renders without throwing', t => {
  const model = open(uiFixture(t), 'claude:done-1', 80);
  for (const [columns, rows] of [[1, 1], [5, 3], [29, 7], [109, 9], [110, 9], [400, 200]]) {
    model.setSize({ columns, rows });
    assert.ok(screen(model).length);
  }
});

test('cards: caller titles, companion · project, running clock, age, older count', t => {
  const text = screen(uiFixture(t).model());
  assert.match(text, /● Restore spec triage +0:41 │/);
  assert.match(text, /● Step 1b-2: digest on demand +4:12 │/);
  assert.match(text, /codex · agent-companion/);
  assert.match(text, /✓ Review auth middleware +12m │/);
  assert.match(text, /✗ rate limit probe +1h │/, 'the Codex task name titles the job');
  assert.match(text, /1 older/);
  assert.match(text, /2 running · 2 done in 24h/);
});

test('follow: appended items arrive at the bottom; moving up stops following until G', t => {
  const f = uiFixture(t);
  const model = open(f, 'claude:run-1', 150);
  press(model, 'tab');
  f.append([codexItem('turn-2', { type: 'AgentMessage', id: 'n1', content: [{ type: 'text', text: 'NEW-REPLY-1' }] })]);
  model.tick();
  const rows = screen(model).split('\n');
  assert.ok(rows.findIndex(row => row.includes('NEW-REPLY-1')) > rows.length - 8, 'the new reply is near the bottom');
  assert.match(rows.at(-3), /● running \$ node --test lib\/digest.test.mjs/, 'the live line is the last transcript line');
  press(model, 'upArrow', 'upArrow');
  f.append(Array.from({ length: 30 }, (_, i) => codexItem('turn-2', { type: 'AgentMessage', id: `m${i}`, content: [{ type: 'text', text: `LATER-${i}` }] })));
  model.tick();
  assert.doesNotMatch(screen(model), /LATER-29/);
  press(model, 'G');
  assert.match(screen(model), /LATER-29/);
});

test('folding: e expands the cursor item, E expands all, p shows the preamble', t => {
  const model = open(uiFixture(t), 'claude:run-1', 150, 80);
  press(model, 'tab', 'g');
  assert.match(screen(model), /\+19 lines/);
  assert.match(screen(model), /preamble · 1 item · p shows/);
  // Preamble notice, prompt, reasoning, then the first command.
  press(model, 'downArrow', 'downArrow', 'downArrow', 'e');
  assert.doesNotMatch(screen(model), /\+19 lines/);
  assert.match(screen(model), /DIGEST_12/);
  press(model, 'g', 'E');
  assert.match(screen(model), /Requirement 44\./);
  press(model, 'p');
  assert.match(screen(model), /You are Codex\./);
});

test('a finished job opens on its outcome and shows its answer once', t => {
  const model = open(uiFixture(t), 'claude:done-1', 150);
  const text = screen(model);
  assert.match(text, /✓ done in 6:02 {2}3 commands, 1 failed · 2 files changed/);
  assert.match(text, /git, any writer: src\/auth\.ts \+18 −6 · src\/auth\.test\.ts \+40/);
  assert.match(text, /still fails\.[\s\S]*Changes:[\s\S]*\+3/);
  model.key('', { tab: true });
  press(model, 'G');
  assert.match(screen(model), /answer, shown above/);
  assert.match(screen(model), /\$ npm test +exit 1/);
  assert.match(screen(model), /✎ src\/auth\.ts {2}updated/);
});

test('live line: OpenCode partial reply from progress, and no transcript yet', t => {
  const model = open(uiFixture(t), 'claude:op-1', 150);
  const text = screen(model);
  assert.match(text, /waiting for the transcript/);
  assert.match(text, /Reading the restore spec\n[^\n]*● responding/);
});

test('filter and older jobs', t => {
  const model = uiFixture(t).model();
  press(model, '/', 'a', 'u', 't', 'h');
  assert.match(screen(model), / \/auth▌/);
  press(model, 'return');
  const filtered = screen(model);
  assert.match(filtered, /Review auth middleware/);
  assert.doesNotMatch(filtered, /Restore spec triage/);
  press(model, '/', 'escape');
  assert.match(screen(model), /Restore spec triage/);
  press(model, 'o');
  assert.match(screen(model), /Antigravity scenario/);
});

test('native terminal escapes never reach the frame', t => {
  const model = open(uiFixture(t), 'claude:run-1', 150);
  press(model, 'E');
  const cells = model.render().flat().map(([text]) => text).join('');
  assert.match(cells, /tests 1 failed/);
  assert.doesNotMatch(cells, /\x1b/);
});

test('a multi-line command, activity or title never puts a newline inside a frame row', t => {
  const f = uiFixture(t);
  f.append([codexItem('turn-2', { type: 'CommandExecution', id: 'heredoc', command: ['/bin/zsh', '-lc', "cat > notes.txt <<'EOF'\nfirst\nsecond\nEOF"], status: 'completed', exit_code: 0, aggregated_output: '' })]);
  f.setExecution('run-1', () => ({ progress: { activeCommand: 'python3 - <<EOF\nprint(1)\nEOF', lastActivityAt: f.NOW } }));
  const model = open(f, 'claude:run-1', 150, 40);
  model.tick();
  const rows = model.render().map(row => row.map(([text]) => text).join(''));
  assert.equal(rows.length, 40);
  for (const row of rows) assert.doesNotMatch(row, /\n/);
  const text = rows.join('\n');
  assert.match(text, /\$ cat > notes\.txt <<'EOF' +ok\n[^\n]*│ {4}first *\n[^\n]*│ {4}second/);
  assert.match(text, /● running \$ python3 - <<EOF/);
});
