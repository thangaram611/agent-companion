import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as daemonClient from './daemon-client.mjs';
import {
  cancelPrompt,
  ensureRuntime,
  inspectPrompt,
  promptBg,
  replyPrompt,
  runtimeStatus,
  selectedRuntimeAdapter,
  watchPrompt,
} from './copilot-runtime.mjs';

async function withEnv(key, value, fn) {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return await fn(); }
  finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

test('ACP runtime adapter maps bridge methods to daemon socket commands', async () => {
  await withEnv('COPILOT_RUNTIME_ADAPTER', 'acp', async () => {
    const calls = [];
    daemonClient._setForTest({
      ensureDaemon: async (opts) => { calls.push(['ensure', opts]); },
      sendToSocket: async (message, timeoutMs) => {
        calls.push(['send', message, timeoutMs]);
        return { ok: true, data: { command: message.command } };
      },
    });
    try {
      assert.equal(selectedRuntimeAdapter(), 'acp');
      await ensureRuntime({ reqId: 'req-1' });
      await runtimeStatus(123);
      await promptBg({ sessionId: 'sid', text: 'hello', cwd: '/repo', model: 'gpt-5.5', reqId: 'req-2' });
      await watchPrompt({ promptId: 'pid', wait: 10, summaryOnly: true }, 456);
      await inspectPrompt({ promptId: 'pid', includeTimeline: true, limit: 9 });
      await cancelPrompt({ promptId: 'pid' });
      await replyPrompt({ promptId: 'pid', message: 'continue' });
    } finally {
      daemonClient._resetForTest();
    }

    assert.deepEqual(calls, [
      ['ensure', { reqId: 'req-1' }],
      ['send', { command: 'status' }, 123],
      ['send', { command: 'prompt-bg', sessionId: 'sid', text: 'hello', cwd: '/repo', model: 'gpt-5.5', reqId: 'req-2' }, undefined],
      ['send', { command: 'watch', promptId: 'pid', since: 0, raw: false, wait: 10, summaryOnly: true }, 456],
      ['send', { command: 'inspect', promptId: 'pid', includeTimeline: true, limit: 9 }, 15000],
      ['send', { command: 'cancel', promptId: 'pid' }, undefined],
      ['send', { command: 'reply', promptId: 'pid', message: 'continue' }, 15000],
    ]);
  });
});

test('unsupported runtime adapters fail before daemon calls', async () => {
  await withEnv('COPILOT_RUNTIME_ADAPTER', 'sdk', async () => {
    daemonClient._setForTest({
      ensureDaemon: async () => { throw new Error('must not ensure daemon'); },
      sendToSocket: async () => { throw new Error('must not send socket message'); },
    });
    try {
      await assert.rejects(
        () => ensureRuntime({ reqId: 'req-sdk' }),
        (err) => err.code === 'RUNTIME_ADAPTER_UNSUPPORTED' && /unsupported Copilot runtime adapter "sdk"/.test(err.message),
      );
      await assert.rejects(
        () => runtimeStatus(),
        (err) => err.code === 'RUNTIME_ADAPTER_UNSUPPORTED',
      );
    } finally {
      daemonClient._resetForTest();
    }
  });
});
