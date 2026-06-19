import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  _resetSdkRuntimeForTest,
  _setSdkModuleForTest,
  cancelPrompt,
  inspectPrompt,
  promptBg,
  replyPrompt,
  runtimeStatus,
  watchPrompt,
} from './copilot-sdk-runtime.mjs';

class FakeSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.handlers = [];
    this.sent = [];
    this.aborted = 0;
    this.disconnected = false;
  }

  on(handler) {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  emit(type, data = {}, extra = {}) {
    const event = {
      id: `event-${this.handlers.length}-${Date.now()}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      type,
      data,
      ...extra,
    };
    for (const handler of this.handlers) handler(event);
  }

  async send(options) {
    this.sent.push(options);
    return `message-${this.sent.length}`;
  }

  async abort() {
    this.aborted += 1;
  }

  async disconnect() {
    this.disconnected = true;
  }
}

class FakeClient {
  static instances = [];

  constructor(options = {}) {
    this.options = options;
    this.sessions = [];
    this.createConfigs = [];
    this.resumeConfigs = [];
    this.started = false;
    this.stopped = false;
    FakeClient.instances.push(this);
  }

  async start() {
    this.started = true;
  }

  async createSession(config) {
    this.createConfigs.push(config);
    const session = new FakeSession(`sdk-session-${this.sessions.length + 1}`);
    this.sessions.push(session);
    return session;
  }

  async resumeSession(sessionId, config) {
    this.resumeConfigs.push({ sessionId, config });
    if (sessionId !== 'resume-ok') throw new Error('missing session');
    const session = new FakeSession(sessionId);
    this.sessions.push(session);
    return session;
  }

  async getStatus() {
    return { version: 'fake-sdk-runtime' };
  }

  async stop() {
    this.stopped = true;
    return [];
  }
}

function installFakeSdk() {
  FakeClient.instances = [];
  _setSdkModuleForTest({
    CopilotClient: FakeClient,
    RuntimeConnection: {
      forStdio: (options) => ({ kind: 'stdio', options }),
    },
    approveAll: async () => ({ kind: 'approve-once' }),
  });
}

function withRuntimeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-sdk-runtime-test-'));
  const prior = process.env.AGENT_RUNTIME_DIR;
  process.env.AGENT_RUNTIME_DIR = dir;
  return () => {
    if (prior === undefined) delete process.env.AGENT_RUNTIME_DIR;
    else process.env.AGENT_RUNTIME_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  };
}

afterEach(async () => {
  await _resetSdkRuntimeForTest();
});

test('SDK runtime sends a background prompt and maps session events to bridge watch/inspect shapes', async () => {
  const cleanup = withRuntimeDir();
  installFakeSdk();
  try {
    const start = await promptBg({ text: 'do work', cwd: process.cwd(), model: 'gpt-5' });
    assert.equal(start.ok, true);
    assert.equal(start.data.sessionId, 'sdk-session-1');

    const client = FakeClient.instances[0];
    const session = client.sessions[0];
    assert.equal(client.started, true);
    assert.equal(client.createConfigs[0].workingDirectory, process.cwd());
    assert.equal(client.createConfigs[0].streaming, true);
    assert.equal(client.createConfigs[0].reasoningEffort, undefined);
    assert.deepEqual(session.sent[0], {
      prompt: 'do work',
      mode: 'enqueue',
      agentMode: 'autopilot',
    });

    session.emit('assistant.message_delta', { messageId: 'm1', deltaContent: 'hello ' });
    session.emit('assistant.message', { messageId: 'm1', content: 'hello world' });
    session.emit('tool.execution_start', { toolCallId: 'tool-1', toolName: 'read_file', arguments: { path: 'README.md' } });
    session.emit('tool.execution_complete', { toolCallId: 'tool-1', success: true, result: { content: 'done' } });
    session.emit('session.idle', {});

    const watched = await watchPrompt({ promptId: start.data.promptId, wait: 0, summaryOnly: true });
    assert.equal(watched.ok, true);
    assert.equal(watched.data.status, 'completed');
    assert.equal(watched.data.summary.message, 'hello world');
    assert.equal(watched.data.summary.toolCalls[0].name, 'read_file');

    const inspected = await inspectPrompt({ promptId: start.data.promptId, includeTimeline: true });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.data.status, 'completed');
    assert.equal(inspected.data.lastAssistantOutput, 'hello world');
    assert.match(inspected.data.activity.join('\n'), /read file README\.md/);

    const { buildDigest } = await import('../lib/prompt-digest.mjs');
    const digest = buildDigest(start.data.promptId, { jobId: 'job-sdk-digest', status: 'completed' });
    assert.match(digest, /Source files touched/);
    assert.match(digest, /README\.md/);

    const status = await runtimeStatus();
    assert.equal(status.ok, true);
    assert.equal(status.data.connected, true);
    assert.equal(status.data.sdkStatus.version, 'fake-sdk-runtime');
  } finally {
    cleanup();
  }
});

test('SDK runtime maps model call failures to a failed prompt with provider error text', async () => {
  const cleanup = withRuntimeDir();
  installFakeSdk();
  try {
    const start = await promptBg({ text: 'use unavailable model', cwd: process.cwd(), model: 'gpt-4.1' });
    const session = FakeClient.instances[0].sessions[0];

    session.emit('model.call_failure', {
      errorMessage: 'model gpt-4.1 is unavailable for this account',
      model: 'gpt-4.1',
      tokenType: 'oauth',
    });

    const watched = await watchPrompt({ promptId: start.data.promptId, summaryOnly: true });
    assert.equal(watched.ok, true);
    assert.equal(watched.data.status, 'failed');
    assert.match(watched.data.error, /gpt-4\.1 is unavailable/);

    const inspected = await inspectPrompt({ promptId: start.data.promptId, includeTimeline: true });
    assert.equal(inspected.data.status, 'failed');
  } finally {
    cleanup();
  }
});

test('SDK runtime cancel and reply preserve the bridge prompt replacement contract', async () => {
  const cleanup = withRuntimeDir();
  installFakeSdk();
  try {
    const start = await promptBg({ text: 'long work', cwd: process.cwd(), model: 'gpt-5' });
    const session = FakeClient.instances[0].sessions[0];

    const cancel = await cancelPrompt({ promptId: start.data.promptId });
    assert.equal(cancel.ok, true);
    assert.equal(cancel.data.cancelled, true);
    assert.equal(session.aborted, 1);

    const cancelled = await watchPrompt({ promptId: start.data.promptId, summaryOnly: true });
    assert.equal(cancelled.data.status, 'cancelled');

    const second = await promptBg({ sessionId: start.data.sessionId, text: 'again', cwd: process.cwd(), model: 'gpt-5' });
    const reply = await replyPrompt({ promptId: second.data.promptId, message: 'use a smaller scope' });
    assert.equal(reply.ok, true);
    assert.notEqual(reply.data.new_prompt_id, second.data.promptId);
    assert.equal(reply.data.session_id, start.data.sessionId);
    assert.equal(session.aborted, 2);

    const replacement = await watchPrompt({ promptId: reply.data.new_prompt_id, summaryOnly: true });
    assert.equal(replacement.data.status, 'running');
    assert.match(session.sent.at(-1).prompt, /use a smaller scope/);
  } finally {
    cleanup();
  }
});
