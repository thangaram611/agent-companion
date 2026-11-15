import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_IDS, getTargetById } from './target-registry.mjs';

const modes = {
  opencode: { default: 'steer', steer: true, queue: 'bridge', interrupt: true },
  copilot: { default: null, steer: false, queue: false, interrupt: false },
  codex: { default: 'steer', steer: true, queue: 'bridge', interrupt: true },
  claude: { default: 'queue', steer: false, queue: 'native', interrupt: true },
  antigravity: { default: 'queue', steer: false, queue: 'bridge', interrupt: true },
};

test('every target declares intervention modes once, under capabilities', () => {
  assert.deepEqual(TARGET_IDS, new Set(Object.keys(modes)));
  for (const id of TARGET_IDS) {
    const target = getTargetById(id);
    assert.deepEqual(target.capabilities.interventions, modes[id], id);
    assert.equal(Object.isFrozen(target.capabilities.interventions), true, id);
    assert.equal(Object.hasOwn(target.capabilities, 'reply'), false, id);
    assert.equal(Object.hasOwn(target.acp ?? {}, 'interventions'), false, id);
  }
});
