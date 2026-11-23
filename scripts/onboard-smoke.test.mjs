import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runSmoke } from './onboard.mjs';
import { ManualClock, fakeAdapter, deferred, until } from '../test/controller/helpers.mjs';

function smokeFixture(id, terminal) {
  const clock = new ManualClock();
  const adapter = fakeAdapter({ history: { historyId: 'smoke-history' }, ack: { nativeTurnId: 'smoke-turn' } });
  adapter.terminal.resolve(terminal);
  const provider = { enabled: true, ready: true, create: () => adapter };
  const pending = runSmoke(id, {}, { clock, providers: { [id]: provider },
    createSupervisor: () => ({ spawn() {}, async terminate() { adapter.calls.push(['terminate']); return { gone: true, survivors: [], signals: [] }; } }) });
  return { clock, pending, cwd: () => adapter.calls.find(([name]) => name === 'start')[1].cwd,
    get calls() {
      return adapter.calls.map(([name, args]) => {
        if (name === 'start') return [name, args.model];
        if (name === 'openHistory') return ['history', args.historyId];
        if (name === 'deliver') return [name, args.text];
        return [name];
      });
    } };
}

for (const id of ['codex', 'opencode', 'copilot', 'antigravity', 'claude']) {
  test(`${id} smoke performs one controller job and cleans up before returning`, async () => {
    const h = smokeFixture(id, Promise.resolve({ outcome: 'completed', text: 'ready', cause: 'native_complete' }));
    assert.deepEqual(await h.pending, { supported: true, passed: true, detail: 'ready' });
    assert.deepEqual(h.calls, [['start', undefined], ['history', null], ['deliver', 'Reply with the single word: ready'], ['observe'], ['close'], ['terminate']]);
    assert.equal(existsSync(h.cwd()), false);
    assert.equal(h.clock.timers.size, 0);
  });
}
for (const terminal of [{ outcome: 'failed', text: 'ready' }, { outcome: 'completed', text: '' }, { outcome: 'completed', text: 'not ready' }]) {
  test(`smoke rejects ${JSON.stringify(terminal)}`, async () => {
    const h = smokeFixture('codex', Promise.resolve(terminal));
    assert.equal((await h.pending).passed, false);
    assert.equal(existsSync(h.cwd()), false);
  });
}

test('the two-minute smoke budget cancels through the controller and verifies cleanup', async () => {
  const h = smokeFixture('codex', deferred().promise);
  await until(() => h.calls.some(([name]) => name === 'observe'));
  await h.clock.advance(119_999);
  assert.equal(h.calls.some(([name]) => name === 'interrupt'), false);
  await h.clock.advance(1);
  const result = await h.pending;
  assert.equal(result.passed, false);
  assert.deepEqual(h.calls.slice(-3), [['interrupt'], ['close'], ['terminate']]);
  assert.equal(existsSync(h.cwd()), false);
  assert.equal(h.clock.timers.size, 0);
});
