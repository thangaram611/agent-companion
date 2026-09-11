import '../test/sandbox-home.mjs';
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
} from './acp-runtime.mjs';

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
      sendToSocket: async (message, timeoutMs, companion) => {
        calls.push(['send', message, timeoutMs, companion]);
        return { ok: true, data: { command: message.command } };
      },
    });
    try {
      assert.equal(selectedRuntimeAdapter(), 'acp');
      assert.equal(runtimeSupportsDetachedPromptResume(), true);
      await ensureRuntime({ reqId: 'req-1' });
      await runtimeStatus(123);
      await promptBg({ sessionId: 'sid', text: 'hello', cwd: '/repo', model: 'claude-sonnet-4.6', reqId: 'req-2' });
      await watchPrompt({ promptId: 'pid', wait: 10, summaryOnly: true }, 456);
      await inspectPrompt({ promptId: 'pid', includeTimeline: true, limit: 9 });
      await cancelPrompt({ promptId: 'pid' });
      await replyPrompt({ promptId: 'pid', message: 'continue' });
    } finally {
      daemonClient._resetForTest();
    }

    // Copilot is the default companion, so every call lands on its socket and
    // the IPC messages are byte-identical to what the daemon always received.
    assert.deepEqual(calls, [
      ['ensure', { reqId: 'req-1', companion: 'copilot' }],
      ['send', { command: 'status' }, 123, 'copilot'],
      ['send', { command: 'prompt-bg', sessionId: 'sid', text: 'hello', cwd: '/repo', model: 'claude-sonnet-4.6', reqId: 'req-2' }, undefined, 'copilot'],
      ['send', { command: 'watch', promptId: 'pid', since: 0, raw: false, wait: 10, summaryOnly: true }, 456, 'copilot'],
      ['send', { command: 'inspect', promptId: 'pid', includeTimeline: true, limit: 9 }, 15000, 'copilot'],
      ['send', { command: 'cancel', promptId: 'pid' }, undefined, 'copilot'],
      ['send', { command: 'reply', promptId: 'pid', message: 'continue' }, 15000, 'copilot'],
    ]);
  });
});

test('a second ACP companion routes to its own daemon socket and never through the Copilot SDK adapter', async () => {
  // Even with the SDK adapter selected for Copilot, a Acme call is a daemon
  // call: the adapter knob is Copilot's alone.
  await withEnv('COPILOT_RUNTIME_ADAPTER', 'sdk', async () => {
    const calls = [];
    _setSdkRuntimeForTest({
      ensureRuntime: async () => { throw new Error('the SDK adapter must not serve acme'); },
      promptBg: async () => { throw new Error('the SDK adapter must not serve acme'); },
    });
    daemonClient._setForTest({
      ensureDaemon: async (opts) => { calls.push(['ensure', opts]); },
      sendToSocket: async (message, timeoutMs, companion) => {
        calls.push(['send', message, timeoutMs, companion]);
        return { ok: true, data: {} };
      },
    });
    try {
      assert.equal(runtimeSupportsDetachedPromptResume('acme'), true, 'the Acme daemon is detached by construction');
      await ensureRuntime({ reqId: 'req-g', companion: 'acme' });
      await promptBg({ sessionId: null, text: 'hi', cwd: '/repo', model: null, reqId: 'req-g2', companion: 'acme' });
      await watchPrompt({ promptId: 'gp', wait: 5, summaryOnly: true, companion: 'acme' }, 99);
      await cancelPrompt({ promptId: 'gp', companion: 'acme' });
      await replyPrompt({ promptId: 'gp', message: 'more', companion: 'acme' });
    } finally {
      _resetSdkRuntimeForTest();
      daemonClient._resetForTest();
    }
    assert.deepEqual(calls, [
      ['ensure', { reqId: 'req-g', companion: 'acme' }],
      ['send', { command: 'prompt-bg', sessionId: null, text: 'hi', cwd: '/repo', model: null, reqId: 'req-g2' }, undefined, 'acme'],
      ['send', { command: 'watch', promptId: 'gp', since: 0, raw: false, wait: 5, summaryOnly: true }, 99, 'acme'],
      ['send', { command: 'cancel', promptId: 'gp' }, undefined, 'acme'],
      ['send', { command: 'reply', promptId: 'gp', message: 'more' }, 15000, 'acme'],
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
