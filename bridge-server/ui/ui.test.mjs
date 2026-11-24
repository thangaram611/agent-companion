import '../../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToString } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { Screen, run } from './app.mjs';
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
const MODES = { default: 'steer', steer: true, queue: 'bridge', interrupt: true };
const ctrl = (model, letter) => model.key(letter, { ctrl: true });
const type = (model, text) => { for (const ch of text) model.key(ch, {}); };
const enter = model => model.key('\r', { return: true });
// The bridge's side of the inbox contract, by hand: the one request, then its outcome.
function inbox(f, id = 'run-1') {
  const dir = join(f.states.claude, 'inbox', id);
  const requests = () => readdirSync(dir).filter(name => !name.endsWith('.outcome.json'));
  return { dir, requests,
    take() {
      const [name] = requests();
      const request = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      return { name, request, mode: statSync(join(dir, name)).mode & 0o777 };
    },
    answer(requestId, outcome) {
      unlinkSync(join(dir, `${requestId}.json`));
      writeFileSync(join(dir, `${requestId}.outcome.json`), JSON.stringify({ requestId, ...outcome }), { mode: 0o600 });
    } };
}
const styleOf = (model, text) => model.render().flat().find(([cell]) => cell.includes(text))?.[1];

test('running job focused with a queued message and a draft at 150 columns', t => {
  const f = uiFixture(t);
  f.setJob('run-1', () => ({ interventions: [{ id: 'q1', from: 'caller', mode: 'queue', text: 'Also check the logout route.', at: f.NOW - 3000, state: 'accepted' }] }));
  const model = open(f, 'claude:run-1', 150);
  press(model, 'tab');
  type(model, 'Keep the fake server; add an idle event after the step instead.');
  t.assert.snapshot(screen(model), RAW);
});
test('cancel confirmation at 80 columns', t => {
  const model = open(uiFixture(t), 'claude:run-1', 80);
  ctrl(model, 'x');
  t.assert.snapshot(screen(model), RAW);
});

test('opening a running job focuses its box: letters type, ctrl+j adds a line, shift+tab cycles modes, esc keeps each job\'s draft', t => {
  const f = uiFixture(t);
  f.setJob('op-1', () => ({ interventionModes: { default: 'queue', steer: false, queue: 'bridge', interrupt: true } }));
  const model = open(f, 'claude:run-1', 80);
  type(model, 'q?/egG');
  assert.match(screen(model), /│ › q\?\/egG▌ +│/, 'single-letter keys type into the box');
  model.key('\n', {});
  ctrl(model, 'j');
  type(model, 'next');
  model.key('', { backspace: true });
  assert.match(screen(model), /│ › q\?\/egG +│\n +│ +│\n +│   nex▌ +│/, 'ctrl+j, as LF or under the kitty protocol, adds a line');
  model.key('\r', { return: true, meta: true });
  assert.match(screen(model), /│   nex +│\n +│ +▌ +│/, 'shift+⏎ or alt+⏎ adds a line and never sends');
  assert.deepEqual(readdirSync(f.states.claude).filter(name => name === 'inbox'), []);
  assert.match(screen(model), /\n  steer +⏎ send · shift\+⇥ mode · ctrl\+x cancel job · esc jobs$/);
  model.key('', { tab: true, shift: true });
  assert.match(screen(model), /\n  queue +⏎ send/);
  model.key('', { tab: true });
  assert.match(screen(model), /\n  queue +⏎ send/, 'plain tab does nothing in the box');
  model.key('', { tab: true, shift: true });
  model.key('', { tab: true, shift: true });
  assert.match(screen(model), /\n  steer +⏎ send/);
  press(model, 'escape');
  assert.match(screen(model), /↑↓ jobs {3}⏎ open/);
  press(model, 'upArrow', 'return');
  assert.match(screen(model), /│ › Message OpenCode… +│/);
  assert.match(screen(model), /\n  queue +⏎ send · shift\+⇥ mode/, 'a job starts on its own default mode');
  type(model, 'other');
  press(model, 'escape', 'downArrow', 'return');
  assert.match(screen(model), /│   nex +│\n +│ +▌ +│/, 'each job keeps its own draft');
  assert.match(screen(model), /\+7 lines/);
  ctrl(model, 'o');
  assert.match(screen(model), /at frame 4/, 'ctrl+o expands all outputs');
  ctrl(model, 'o');
  assert.match(screen(model), /\+7 lines/);
});

test('⏎ writes one private request per the inbox contract; its outcome is read once and deleted; the companion\'s copy is labelled you', t => {
  const f = uiFixture(t), box = inbox(f);
  const model = open(f, 'claude:run-1', 80);
  enter(model);
  type(model, '   ');
  enter(model);
  assert.throws(() => box.requests(), { code: 'ENOENT' }, 'an empty or blank box sends nothing');
  ctrl(model, 'c');
  model.paste('Keep the fake server;\x1b[31m\x9b\x85\u202e\r\nadd an idle event.');
  enter(model);
  const { name, request, mode } = box.take();
  assert.deepEqual(box.requests(), [name], 'one file, no temporary left');
  assert.deepEqual(request, { requestId: name.slice(0, -5), jobId: 'run-1', mode: 'steer', text: 'Keep the fake server;\nadd an idle event.', at: f.NOW }, 'escape sequences, C1 controls and bidi overrides are not text');
  assert.equal(mode, 0o600);
  assert.equal(statSync(box.dir).mode & 0o777, 0o700);
  assert.match(screen(model), /◌ you · waiting for the bridge  Keep the fake server; add an idle event\.\n +╭/);
  assert.match(screen(model), /│ › Message Codex… +│/, 'the box is cleared');
  model.tick();
  assert.match(screen(model), /waiting for the bridge/);

  box.answer(request.requestId, { ok: true, status: 'accepted', interventionId: 'i-1' });
  model.tick();
  assert.deepEqual(readdirSync(box.dir), [], 'the outcome is deleted once read');
  assert.match(screen(model), /◌ you · accepted  Keep the fake server/);
  f.setJob('run-1', () => ({ interventions: [{ id: 'i-1', from: 'user', mode: 'steer', text: request.text, at: f.NOW, state: 'joined' }] }));
  model.tick();
  assert.match(screen(model), /◌ you · joined  Keep the fake server; add an idle event\.  in the running turn/);
  assert.doesNotMatch(screen(model), /accepted/);
  f.append([codexItem('turn-2', { type: 'UserMessage', id: 'steer-1', content: [{ type: 'text', text: request.text }] })]);
  model.tick();
  assert.match(screen(model), /you {4}Keep the fake server;  +\+1/, 'the companion took it: the transcript shows it as yours');
  assert.doesNotMatch(screen(model), /◌ you/);
});

test('a refused message shows once in red with its reason and returns to the empty box', t => {
  const f = uiFixture(t), box = inbox(f);
  const model = open(f, 'claude:run-1', 80);
  type(model, 'too long');
  enter(model);
  box.answer(box.take().request.requestId, { ok: false, status: 'intervention_unavailable', reason: 'text_too_long' });
  model.tick();
  assert.match(screen(model), /✗ you · refused: too long  too long/);
  assert.equal(styleOf(model, 'refused'), 'bad');
  assert.match(screen(model), /│ › too long▌ +│/);
  model.key('', { backspace: true });
  enter(model);
  assert.doesNotMatch(screen(model), /refused/, 'the next send replaces the refusal');
  assert.match(screen(model), /◌ you · waiting for the bridge  too lon/);
});

test('ctrl+x asks inside the box: n restores it, y writes a cancel request with no text', t => {
  const f = uiFixture(t), box = inbox(f);
  const model = open(f, 'claude:run-1', 80);
  type(model, 'draft');
  ctrl(model, 'x');
  assert.match(screen(model), /│ Cancel this job\? The lead is told you cancelled it\. +y yes {2}n no │/);
  type(model, 'z');
  enter(model);
  assert.match(screen(model), /Cancel this job\?/, 'other keys wait for an answer');
  press(model, 'n');
  assert.match(screen(model), /│ › draft▌ +│/);
  ctrl(model, 'x');
  press(model, 'y');
  const { request } = box.take();
  assert.deepEqual(request, { requestId: request.requestId, jobId: 'run-1', mode: 'cancel', at: f.NOW });
  assert.match(screen(model), /◌ you · cancel · waiting for the bridge\n/);
  assert.match(screen(model), /│ › draft▌ +│/, 'the draft stays');
  box.answer(request.requestId, { ok: true, status: 'accepted' });
  model.tick();
  assert.match(screen(model), /■ you · cancel · stopping the job/);
});

test('ctrl+c clears a draft, then quits; on the list it quits, and ctrl+letters are not letter keys', t => {
  const f = uiFixture(t);
  let quit = 0;
  const model = open(f, 'claude:run-1', 80);
  model.exit = () => quit++;
  type(model, 'abc');
  ctrl(model, 'c');
  assert.equal(quit, 0);
  assert.match(screen(model), /│ › Message Codex… +│/);
  ctrl(model, 'c');
  assert.equal(quit, 1);
  press(model, 'escape');
  ctrl(model, 'o');
  ctrl(model, 'q');
  assert.doesNotMatch(screen(model), /Antigravity scenario/, 'ctrl+o is not o (older jobs)');
  assert.equal(quit, 1, 'ctrl+q is not q');
  ctrl(model, 'c');
  assert.equal(quit, 2);
});

test('pending and transcript labels: task, lead and you from the record; an unmatched message stays user', t => {
  const f = uiFixture(t);
  const at = f.NOW - 60_000;
  f.setJob('run-1', () => ({ interventions: [
    { id: 'l0', from: 'caller', mode: 'steer', text: 'Lead steer.', at, state: 'joined' },
    { id: 'u1', from: 'user', mode: 'interrupt', text: 'Stop and use the idle event.', at: at + 2000, state: 'accepted' },
    { id: 'l1', from: 'caller', mode: 'queue', text: 'Also check the logout route.', at: at + 1000, state: 'accepted' },
    { id: 'u0', from: 'user', mode: 'queue', text: 'Dropped.', at: at + 500, state: 'not_delivered' },
    { id: 'u2', from: 'user', mode: 'steer', text: 'Answered.', at, state: 'answered' }] }));
  f.append([codexItem('turn-2', { type: 'UserMessage', id: 'x1', content: [{ type: 'text', text: 'Lead steer.' }] }),
    codexItem('turn-2', { type: 'UserMessage', id: 'x2', content: [{ type: 'text', text: 'Not recorded.' }] })]);
  const model = open(f, 'claude:run-1', 150, 40);
  press(model, 'tab', 'pageUp', 'pageUp');
  const text = screen(model);
  assert.match(text, /│  task {3}Step 1b-2 of the live-view plan/);
  assert.match(text, /│  lead {3}Lead steer\.\n[^\n]*│  user {3}Not recorded\./);
  press(model, 'pageDown', 'pageDown');
  assert.match(screen(model), /✗ you · not delivered  Dropped\.\n[^\n]*◌ lead · queued  Also check the logout route\.  runs after this turn\n[^\n]*◌ you · interrupting  Stop and use the idle event\.  runs once this turn stops\n[^\n]*╭/);
  assert.doesNotMatch(screen(model), /· joined|Answered/, 'a message in the transcript, or answered, is no longer pending');
});

test('a Claude message that joined the running turn is a message, labelled by its sender', t => {
  const f = uiFixture(t);
  appendFileSync(join(f.root, 'transcripts/claude-done.jsonl'), JSON.stringify({ type: 'attachment', sessionId: 'sess-done', uuid: 'att-1',
    attachment: { type: 'queued_command', prompt: 'Also check the logout route.', source_uuid: 'i-9', commandMode: 'prompt' } }) + '\n');
  f.setJob('done-1', () => ({ interventions: [{ id: 'i-9', from: 'user', mode: 'queue', text: 'Also check the logout route.', at: f.NOW - 13 * 60_000, state: 'answered' }] }));
  const model = open(f, 'claude:done-1', 150, 60);
  const text = screen(model);
  assert.match(text, /│  task {3}Review the auth middleware/);
  assert.match(text, /│  you {4}Also check the logout route\./);
  assert.doesNotMatch(text, /preamble ·/);
});

test('a companion with no message modes offers cancel only', t => {
  const f = uiFixture(t);
  f.setJob('run-1', () => ({ interventionModes: { default: null, steer: false, queue: false, interrupt: false } }));
  const model = open(f, 'claude:run-1', 80);
  type(model, 'ignored');
  enter(model);
  model.paste('ignored');
  const text = screen(model);
  assert.match(text, /│ › Codex takes no messages while it works +│\n +╰─+╯\n  cancel only +ctrl\+x cancel job · esc jobs$/);
  ctrl(model, 'x');
  press(model, 'y');
  assert.equal(inbox(f).take().request.mode, 'cancel');
});

test('when the job ends the box goes and the draft stays in memory only', t => {
  const f = uiFixture(t);
  const model = open(f, 'claude:run-1', 80);
  type(model, 'kept draft');
  ctrl(model, 'x');
  f.setJob('run-1', () => ({ state: 'closed' }));
  model.tick();
  const text = screen(model);
  assert.doesNotMatch(text, /╭|kept draft|Cancel this job/);
  assert.match(text, /↑↓ items {3}esc back/);
  assert.equal(model.boxes.get('claude:run-1').draft, 'kept draft');
  assert.deepEqual(readdirSync(f.states.claude).filter(name => name === 'inbox'), [], 'nothing was written');
});

test('a long or many-line draft wraps inside the box; every row fits and none holds a newline', t => {
  const model = open(uiFixture(t), 'claude:run-1', 80);
  model.paste(['first line', 'second ' + 'word '.repeat(40), ...Array.from({ length: 60 }, (_, i) => `line ${i}`)].join('\n'));
  const rows = model.render().map(row => row.map(([text]) => text).join(''));
  assert.equal(rows.length, 26);
  for (const row of rows) { assert.doesNotMatch(row, /\n/); assert.ok(row.length <= 80, row); }
  const text = rows.join('\n');
  assert.match(text, /│ {3}line 59▌ +│\n +╰/, 'the box shows the draft\'s last rows, where the cursor is');
  assert.match(text, /● running \$ node --test lib\/digest.test.mjs/, 'the live line keeps a row');
});

// What bridge-server/ui/defaults.mjs answers for a full read: saved values
// and sources, and what inherit resolves to, natively or from a last run.
const DEFAULTS = () => ({
  settingsFile: '/home/tester/.config/agent-companion/settings.json',
  companion: { saved: 'codex', value: 'codex', source: 'config', inherit: null },
  companions: {
    codex: { model: { saved: null, value: null, source: 'unset' }, effort: { saved: 'high', value: 'high', source: 'config' },
      inherit: { model: 'gpt-6.2-astra', effort: 'xhigh', source: 'config/read' } },
    claude: { model: { saved: null, value: null, source: 'unset' }, effort: { saved: null, value: null, source: 'unset' },
      inherit: { model: 'claude-opus-5-5', effort: null, source: 'last run', host: 'codex', ageMs: 3 * 86_400_000 } },
    copilot: { model: { saved: 'gpt-oss:20b', value: 'gpt-oss:20b', source: 'config' }, effort: { saved: null, value: null, source: 'unset' },
      inherit: { model: null, effort: null, reason: 'no reported run' }, validation: 'unverified until a session runs' },
  },
});
// A fake defaults(): records each query; a saved effort `turbo` is refused.
function fakeDefaults() {
  const calls = [];
  const fn = async (query = {}) => {
    calls.push(query);
    if (query.effort === 'turbo') throw new Error('effort "turbo" is not valid for Codex model "gpt-6.2-astra". Use one of: low, medium, high, xhigh, max, ultra');
    const result = DEFAULTS();
    if (query.defaultCompanion) return { settingsFile: result.settingsFile, companion: { ...result.companion, saved: query.defaultCompanion === 'inherit' ? null : query.defaultCompanion } };
    if (query.companion) {
      const row = result.companions[query.companion];
      for (const key of ['model', 'effort']) if (query[key]) row[key] = query[key] === 'inherit'
        ? { saved: null, value: null, source: 'unset' } : { saved: query[key], value: query[key], source: 'config' };
      return { settingsFile: result.settingsFile, companions: { [query.companion]: row } };
    }
    return result;
  };
  return Object.assign(fn, { calls });
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('d opens the defaults panel: saved values and what inherit resolves to, natively or from a last run; esc closes it', async t => {
  const defaults = fakeDefaults();
  const model = uiFixture(t).model({ size: { columns: 110, rows: 30 }, defaults });
  press(model, 'd');
  assert.match(screen(model), /Reading saved and native defaults…/);
  await settle();
  const text = screen(model);
  for (const row of text.split('\n')) assert.ok(row.length <= 110, row);
  assert.match(text, /Defaults {2}\/home\/tester\/\.config\/agent-companion\/settings\.json/);
  assert.match(text, /companion +codex \(saved\)/);
  assert.match(text, /model +inherit → gpt-6\.2-astra \(config\/read\)/);
  assert.match(text, /effort +high \(saved\)/);
  assert.match(text, /model +inherit → claude-opus-5-5 \(codex last run, 3d ago\)/);
  assert.match(text, /effort +inherit → not reported \(codex last run, 3d ago\)/);
  assert.match(text, /model +gpt-oss:20b \(saved\)/);
  assert.match(text, /unverified until a session runs/);
  assert.match(text, /↑↓ fields {3}⏎ edit {3}esc close/);
  assert.deepEqual(defaults.calls, [{}]);
  press(model, 'escape');
  assert.doesNotMatch(screen(model), /Defaults/);
  assert.match(screen(model), /d defaults/);
});

test('editing a default: ⏎ edits the selected field, ⏎ saves through defaults, a refusal keeps the draft and says why, empty saves inherit', async t => {
  const defaults = fakeDefaults();
  const model = uiFixture(t).model({ size: { columns: 110, rows: 30 }, defaults });
  press(model, 'd'); await settle();
  // defaultCompanion, then codex model, then codex effort.
  press(model, 'downArrow', 'downArrow', 'return');
  assert.match(screen(model), /effort +› high▌/);
  assert.match(screen(model), /⏎ save, empty clears to inherit {3}esc cancel/);
  press(model, 'backspace', 'backspace', 'backspace', 'backspace');
  type(model, 'turbo');
  enter(model); await settle();
  assert.deepEqual(defaults.calls.at(-1), { companion: 'codex', effort: 'turbo' });
  assert.match(screen(model), /effort +› turbo▌/);
  assert.match(screen(model), /✗ effort "turbo" is not valid for Codex model "gpt-6\.2-astra"/);
  press(model, 'backspace', 'backspace', 'backspace', 'backspace', 'backspace');
  type(model, 'max');
  enter(model); await settle();
  assert.deepEqual(defaults.calls.at(-1), { companion: 'codex', effort: 'max' });
  assert.match(screen(model), /effort +max \(saved\)/);
  assert.doesNotMatch(screen(model), /✗/);
  // The codex model, cleared: an empty field saves inherit.
  press(model, 'upArrow', 'return'); enter(model); await settle();
  assert.deepEqual(defaults.calls.at(-1), { companion: 'codex', model: 'inherit' });
  // esc leaves an edit without saving, then closes the panel.
  press(model, 'upArrow', 'return'); type(model, 'opencode'); press(model, 'escape');
  assert.equal(defaults.calls.length, 4);
  assert.match(screen(model), /companion +codex \(saved\)/);
  press(model, 'escape');
  assert.equal(model.panel, null);
});

test('d in a message box is a letter, and the panel never opens over a draft', async t => {
  const defaults = fakeDefaults();
  const f = uiFixture(t);
  const model = f.model({ size: { columns: 150, rows: 26 }, defaults });
  while (model.selected !== 'claude:run-1') press(model, 'downArrow');
  press(model, 'tab');
  type(model, 'add');
  assert.match(screen(model), /› add▌/);
  assert.equal(model.panel, null);
  assert.deepEqual(defaults.calls, []);
});

test('job list at 80 columns', t => t.assert.snapshot(screen(uiFixture(t).model({ size: { columns: 80, rows: 26 } })), RAW));

test('narrow: Enter opens the job full width, Esc returns; resizing keeps it open', t => {
  const model = uiFixture(t).model({ size: { columns: 80, rows: 26 } });
  press(model, 'downArrow', 'return');
  assert.match(screen(model), /Claude Code › Live view plan · gpt-6-astra high · main/);
  assert.doesNotMatch(screen(model), /Restore spec triage/);
  model.setSize({ columns: 150, rows: 26 });
  assert.match(screen(model), /Restore spec triage[\s\S]*│ {2}steer · joins the running turn now +⏎ send/, 'the list returns beside the focused box');
  model.setSize({ columns: 80, rows: 26 });
  press(model, 'escape');
  assert.match(screen(model), /Restore spec triage/);
});

test('any terminal size renders without throwing, with or without a message box', t => {
  const f = uiFixture(t);
  for (const model of [open(f, 'claude:done-1', 80), open(f, 'claude:run-1', 80)]) {
    model.paste('a draft\nof two lines');
    for (const [columns, rows] of [[1, 1], [5, 3], [29, 7], [109, 9], [110, 9], [400, 200]]) {
      model.setSize({ columns, rows });
      assert.ok(screen(model).length);
    }
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

test('follow: appended items arrive above the box; scrolling up stops following until scrolled back down', t => {
  const f = uiFixture(t);
  const model = open(f, 'claude:run-1', 150);
  press(model, 'tab');
  f.append([codexItem('turn-2', { type: 'AgentMessage', id: 'n1', content: [{ type: 'text', text: 'NEW-REPLY-1' }] })]);
  model.tick();
  const rows = screen(model).split('\n');
  const top = rows.findIndex(row => row.includes('╭'));
  assert.ok(rows.findIndex(row => row.includes('NEW-REPLY-1')) > top - 5, 'the new reply is just above the box');
  assert.match(rows[top - 1], /● running \$ node --test lib\/digest.test.mjs/, 'the live line is the last transcript line');
  press(model, 'upArrow', 'upArrow');
  f.append(Array.from({ length: 30 }, (_, i) => codexItem('turn-2', { type: 'AgentMessage', id: `m${i}`, content: [{ type: 'text', text: `LATER-${i}` }] })));
  model.tick();
  assert.doesNotMatch(screen(model), /LATER-29/);
  press(model, 'pageDown', 'pageDown', 'pageDown', 'pageDown', 'pageDown');
  assert.match(screen(model), /LATER-29/);
  f.append([codexItem('turn-2', { type: 'AgentMessage', id: 'n2', content: [{ type: 'text', text: 'FOLLOWED-AGAIN' }] })]);
  model.tick();
  assert.match(screen(model), /FOLLOWED-AGAIN/);
});

test('folding: e expands the cursor item, E expands all, p shows the preamble', t => {
  // Once the job ends, transcript navigation takes the keys.
  const f = uiFixture(t);
  f.setJob('run-1', () => ({ state: 'closed' }));
  const model = open(f, 'claude:run-1', 150, 80);
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
  f.setJob('run-1', () => ({ progress: { activeCommand: 'python3 - <<EOF\nprint(1)\nEOF', lastActivityAt: f.NOW } }));
  const model = open(f, 'claude:run-1', 150, 40);
  model.tick();
  const rows = model.render().map(row => row.map(([text]) => text).join(''));
  assert.equal(rows.length, 40);
  for (const row of rows) assert.doesNotMatch(row, /\n/);
  const text = rows.join('\n');
  assert.match(text, /\$ cat > notes\.txt <<'EOF' +ok\n[^\n]*│ {4}first *\n[^\n]*│ {4}second/);
  assert.match(text, /● running \$ python3 - <<EOF/);
});

test('through Ink\'s stdin: bracketed paste, shift+tab, ctrl+x then y, and ctrl+c reach the box', async t => {
  const f = uiFixture(t);
  const model = f.model({ size: { columns: 80, rows: 26 } });
  const stdout = Object.assign(new Writable({ write(chunk, encoding, done) { done(); } }), { columns: 80, rows: 26, isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const { app } = run({ model, stdout, stdin, pollMs: 1e9, interactive: true, patchConsole: false });
  t.after(() => app.unmount());
  const send = async sequence => { stdin.write(sequence); await new Promise(resolve => setTimeout(resolve, 30)); };
  await send('\x1b[B'); await send('\r');
  await send('\x1b[200~line one\r\nline two\x1b[201~');
  const box = model.boxes.get('claude:run-1');
  assert.equal(box.draft, 'line one\nline two', 'a pasted newline is text, not ⏎');
  await send('\x1b[Z');
  assert.equal(box.mode, 'queue');
  await send('\x18'); await send('y');
  assert.equal(inbox(f).take().request.mode, 'cancel');
  await send('\x03');
  assert.equal(box.draft, '', 'ctrl+c clears the draft first');
  await send('\x03');
  await app.waitUntilExit();
});

test('an empty filter in a finished detail returns focus to the jobs list', t => {
  const model = open(uiFixture(t), 'claude:done-1', 80);
  press(model, '/');
  type(model, 'no-match');
  enter(model);
  press(model, 'g');
  assert.equal(model.inJob, false);
  assert.match(screen(model), /No job matches/);
});

test('filter accepts either ID, short help scrolls, and the empty list reveals older jobs', t => {
  const f = uiFixture(t);
  const model = f.model({ size: { columns: 120, rows: 14 } });
  for (const id of ['run-1', 'th-run']) {
    press(model, '/');
    type(model, id);
    assert.deepEqual(model.jobs.map(j => j.record.jobId), ['run-1']);
    press(model, 'escape');
  }
  press(model, '?', 'pageDown', 'pageDown');
  assert.match(screen(model), /clear the draft/);
  assert.match(screen(model), /esc close/);
  press(model, 'escape');
  const list = model.source.list.bind(model.source);
  model.source.list = () => list().filter(job => job.record.jobId === 'old-1');
  model.tick();
  assert.match(screen(model), /1 older · o to show/);
  press(model, 'o');
  assert.equal(model.jobs[0].record.jobId, 'old-1');
});
