import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runtimeDir,
  queuePath,
  daemonSocketPath,
  daemonLogFile,
  bridgeLogFile,
  heartbeatDir,
  promptJsonlDir,
  digestDir,
  promptEventsPath,
  digestPathForJob,
} from './runtime-paths.mjs';

test('runtime paths default under a private override root and reject unsafe ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-runtime-paths-'));
  const oldRuntime = process.env.AGENT_RUNTIME_DIR;
  process.env.AGENT_RUNTIME_DIR = dir;
  try {
    assert.equal(runtimeDir(), dir);
    assert.equal(queuePath(), join(dir, 'completions.jsonl'));
    assert.equal(daemonSocketPath(), join(dir, 'copilot-acp.sock'));
    assert.equal(daemonLogFile(), join(dir, 'copilot-acp-daemon.log'));
    assert.equal(bridgeLogFile(), join(dir, 'agent-bridge.log'));
    assert.equal(heartbeatDir(), join(dir, 'heartbeats'));
    assert.equal(promptJsonlDir(), join(dir, 'prompts'));
    assert.equal(digestDir(), join(dir, 'digests'));
    assert.equal(promptEventsPath('prompt-1'), join(dir, 'prompts', 'copilot-acp-prompt-1.jsonl'));
    assert.equal(digestPathForJob('job-1'), join(dir, 'digests', 'agent-digest-job-1.md'));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.throws(() => promptEventsPath('../bad'), /promptId must match/);
    assert.throws(() => digestPathForJob('bad/slash'), /jobId must match/);
  } finally {
    if (oldRuntime === undefined) delete process.env.AGENT_RUNTIME_DIR;
    else process.env.AGENT_RUNTIME_DIR = oldRuntime;
    rmSync(dir, { recursive: true, force: true });
  }
});
