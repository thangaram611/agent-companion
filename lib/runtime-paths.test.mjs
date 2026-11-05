import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runtimeDir,
  queuePath,
  bridgeLogFile,
  heartbeatDir,
  promptJsonlDir,
  digestDir,
  promptEventsPath,
  digestPathForJob,
} from './runtime-paths.mjs';

test('runtime paths default under a private override root and reject unsafe ids', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-runtime-paths-'));
  const oldRuntime = process.env.AGENT_RUNTIME_DIR;
  process.env.AGENT_RUNTIME_DIR = dir;
  try {
    assert.equal(runtimeDir(), dir);
    assert.equal(queuePath(), join(dir, 'completions.jsonl'));
    assert.equal(bridgeLogFile(), join(dir, 'agent-bridge.log'));
    // The broker socket has to stay well inside SUN_LEN (~104 bytes on darwin),
    // where an over-long path binds a silently truncated name instead of failing.
    assert.equal(heartbeatDir(), join(dir, 'heartbeats'));
    assert.equal(promptJsonlDir(), join(dir, 'prompts'));
    assert.equal(digestDir(), join(dir, 'digests'));
    assert.equal(promptEventsPath('prompt-1'), join(dir, 'prompts', 'copilot-acp-prompt-1.jsonl'));
    // One ACP daemon per companion: every path is keyed by the companion id,
    // and Copilot's stay byte-identical to what they were before the second
    // companion existed.
    assert.equal(promptEventsPath('prompt-1', 'acme'), join(dir, 'prompts', 'acme-acp-prompt-1.jsonl'));
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
