import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as daemonClient from './daemon-client.mjs';
import {
  cancelPrompt,
  ensureRuntime,
  inspectPrompt,
  promptBg,
  replyPrompt,
  runtimeSupportsDetachedPromptResume,
  runtimeStatus,
  selectedRuntimeAdapter,
  _resetSdkRuntimeForTest,
  _setSdkRuntimeForTest,
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
      assert.equal(runtimeSupportsDetachedPromptResume(), true);
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

test('unknown runtime adapters fail before daemon calls', async () => {
  await withEnv('COPILOT_RUNTIME_ADAPTER', 'bogus', async () => {
    daemonClient._setForTest({
      ensureDaemon: async () => { throw new Error('must not ensure daemon'); },
      sendToSocket: async () => { throw new Error('must not send socket message'); },
    });
    try {
      await assert.rejects(
        () => ensureRuntime({ reqId: 'req-bogus' }),
        (err) => err.code === 'RUNTIME_ADAPTER_UNSUPPORTED' && /unsupported Copilot runtime adapter "bogus"/.test(err.message),
      );
      await assert.rejects(
        () => runtimeStatus(),
        (err) => err.code === 'RUNTIME_ADAPTER_UNSUPPORTED',
      );
      assert.throws(
        () => runtimeSupportsDetachedPromptResume(),
        (err) => err.code === 'RUNTIME_ADAPTER_UNSUPPORTED',
      );
    } finally {
      daemonClient._resetForTest();
    }
  });
});

test('SDK runtime adapter dispatches through the SDK backend boundary', async () => {
  await withEnv('COPILOT_RUNTIME_ADAPTER', 'sdk', async () => {
    const calls = [];
    _setSdkRuntimeForTest({
      ensureRuntime: async (opts) => { calls.push(['ensure', opts]); },
      runtimeStatus: async (timeoutMs) => {
        calls.push(['status', timeoutMs]);
        return { ok: true, data: { connected: true } };
      },
      promptBg: async (message) => {
        calls.push(['promptBg', message]);
        return { ok: true, data: { promptId: 'pid-sdk' } };
      },
      watchPrompt: async (message, timeoutMs) => {
        calls.push(['watch', message, timeoutMs]);
        return { ok: true, data: { status: 'completed' } };
      },
      inspectPrompt: async (message, timeoutMs) => {
        calls.push(['inspect', message, timeoutMs]);
        return { ok: true, data: { promptId: message.promptId } };
      },
      cancelPrompt: async (message) => {
        calls.push(['cancel', message]);
        return { ok: true, data: { cancelled: true } };
      },
      replyPrompt: async (message, timeoutMs) => {
        calls.push(['reply', message, timeoutMs]);
        return { ok: true, data: { ok: true } };
      },
    });
    daemonClient._setForTest({
      ensureDaemon: async () => { throw new Error('must not ensure daemon'); },
      sendToSocket: async () => { throw new Error('must not send socket message'); },
    });
    try {
      assert.equal(selectedRuntimeAdapter(), 'sdk');
      assert.equal(runtimeSupportsDetachedPromptResume(), false);
      await ensureRuntime({ reqId: 'req-sdk' });
      await runtimeStatus(111);
      await promptBg({ sessionId: 'sid', text: 'hello', cwd: '/repo', model: 'gpt-5', reqId: 'req-3' });
      await watchPrompt({ promptId: 'pid-sdk', wait: 1 }, 222);
      await inspectPrompt({ promptId: 'pid-sdk' }, 333);
      await cancelPrompt({ promptId: 'pid-sdk' });
      await replyPrompt({ promptId: 'pid-sdk', message: 'continue' }, 444);
    } finally {
      _resetSdkRuntimeForTest();
      daemonClient._resetForTest();
    }

    assert.deepEqual(calls, [
      ['ensure', { reqId: 'req-sdk' }],
      ['status', 111],
      ['promptBg', { command: 'prompt-bg', sessionId: 'sid', text: 'hello', cwd: '/repo', model: 'gpt-5', reqId: 'req-3' }],
      ['watch', { command: 'watch', promptId: 'pid-sdk', since: 0, raw: false, wait: 1, summaryOnly: false }, 222],
      ['inspect', { command: 'inspect', promptId: 'pid-sdk', includeTimeline: false, limit: 40 }, 333],
      ['cancel', { command: 'cancel', promptId: 'pid-sdk' }],
      ['reply', { command: 'reply', promptId: 'pid-sdk', message: 'continue' }, 444],
    ]);
  });
});
