import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_IDS, getCompanionById } from './companion-registry.mjs';

const modes = {
  opencode: { default: 'steer', steer: true, queue: 'bridge', interrupt: true },
  copilot: { default: null, steer: false, queue: false, interrupt: false },
  codex: { default: 'steer', steer: true, queue: 'bridge', interrupt: true },
  claude: { default: 'queue', steer: false, queue: 'native', interrupt: true },
  antigravity: { default: 'steer', steer: true, queue: 'bridge', interrupt: true },
};

test('every companion declares intervention modes once, under capabilities', () => {
  assert.deepEqual(COMPANION_IDS, new Set(Object.keys(modes)));
  for (const id of COMPANION_IDS) {
    const companion = getCompanionById(id);
    assert.deepEqual(companion.capabilities.interventions, modes[id], id);
    assert.equal(Object.isFrozen(companion.capabilities.interventions), true, id);
    assert.equal(Object.hasOwn(companion.capabilities, 'reply'), false, id);
    assert.equal(Object.hasOwn(companion.acp ?? {}, 'interventions'), false, id);
  }
});

test('Antigravity checks the macOS keychain exit status without exposing its output', () => {
  const probe = getCompanionById('antigravity').auth.probe;
  for (const [status, authenticated] of [[0, true], [44, false], [1, 'unknown']]) {
    const result = probe({ platform: 'darwin', run(cmd, args) {
      assert.equal(cmd, 'security');
      assert.deepEqual(args, ['find-generic-password', '-s', 'gemini', '-a', 'antigravity']);
      return { ok: status === 0, status, output: 'private keychain attributes' };
    } });
    assert.equal(result.authenticated, authenticated);
    assert.doesNotMatch(result.detail, /private keychain attributes/);
  }
  assert.equal(probe({ platform: 'linux', run: () => assert.fail('unexpected keychain lookup') }).authenticated, 'unknown');
});
