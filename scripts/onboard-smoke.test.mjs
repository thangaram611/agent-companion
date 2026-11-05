import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runSmoke } from './onboard.mjs';
import { ManualClock, deferred, until } from '../test/controller/helpers.mjs';

function smokeFixture(id, terminal) {
  const clock = new ManualClock();
  const calls = [];
  let cwd;
  const provider = { enabled: true, ready: true, create: () => ({
    capabilities: { loadsHistory: true, followUp: true },
    async start(args) { cwd = args.cwd; calls.push(['start', args.model]); },
    async openHistory(args) { calls.push(['history', args.historyId]); return { historyId: 'smoke-history' }; },
    async deliver(args) { calls.push(['deliver', args.text]); return { nativeTurnId: 'smoke-turn' }; },
    observe() { calls.push(['observe']); return terminal; },
    async interrupt() { calls.push(['interrupt']); },
    async close() { calls.push(['close']); },
  }) };
  const pending = runSmoke(id, {}, { clock, providers: { [id]: provider },
    createSupervisor: () => ({ async terminate() { calls.push(['terminate']); return { gone: true, survivors: [], signals: [] }; } }) });
  return { clock, calls, pending, cwd: () => cwd };
}

for (const id of ['codex', 'opencode', 'copilot', 'antigravity']) {
  test(`${id} smoke performs one controller execution and cleans up before returning`, async () => {
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
