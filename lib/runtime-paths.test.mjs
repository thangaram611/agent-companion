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
  codexBrokerSocketPath,
  codexBrokerLogFile,
  heartbeatDir,
  promptJsonlDir,
  digestDir,
  promptEventsPath,
  digestPathForJob,
  acpDaemonRegistryPath,
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
    assert.equal(codexBrokerSocketPath(), join(dir, 'codex-app-server.sock'));
    assert.equal(codexBrokerLogFile(), join(dir, 'codex-app-server-broker.log'));
    // The broker socket has to stay well inside SUN_LEN (~104 bytes on darwin),
    // where an over-long path binds a silently truncated name instead of failing.
    assert.ok(codexBrokerSocketPath().length < 104);
    assert.equal(heartbeatDir(), join(dir, 'heartbeats'));
    assert.equal(promptJsonlDir(), join(dir, 'prompts'));
    assert.equal(digestDir(), join(dir, 'digests'));
    assert.equal(promptEventsPath('prompt-1'), join(dir, 'prompts', 'copilot-acp-prompt-1.jsonl'));
    // One ACP daemon per companion: every path is keyed by the companion id,
    // and Copilot's stay byte-identical to what they were before the second
    // companion existed.
    assert.equal(daemonSocketPath('copilot'), daemonSocketPath());
    assert.equal(daemonSocketPath('acme'), join(dir, 'acme-acp.sock'));
    assert.equal(daemonLogFile('acme'), join(dir, 'acme-acp-daemon.log'));
    assert.equal(promptEventsPath('prompt-1', 'acme'), join(dir, 'prompts', 'acme-acp-prompt-1.jsonl'));
    assert.equal(acpDaemonRegistryPath(), join(dir, 'acp-daemons.json'));
    assert.throws(() => daemonSocketPath('../x'), /companion must match/);
    assert.equal(digestPathForJob('job-1'), join(dir, 'digests', 'agent-digest-job-1.md'));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.throws(() => promptEventsPath('../bad'), /promptId must match/);
    assert.throws(() => digestPathForJob('bad/slash'), /jobId must match/);
    // The per-companion override follows the companion's own env prefix, so
    // COPILOT_SOCKET_PATH keeps meaning what it did and ACME_SOCKET_PATH is
    // its twin.
    process.env.ACME_SOCKET_PATH = '/tmp/g.sock';
    try { assert.equal(daemonSocketPath('acme'), '/tmp/g.sock'); }
    finally { delete process.env.ACME_SOCKET_PATH; }
    assert.equal(daemonSocketPath('copilot'), join(dir, 'copilot-acp.sock'));
  } finally {
    if (oldRuntime === undefined) delete process.env.AGENT_RUNTIME_DIR;
    else process.env.AGENT_RUNTIME_DIR = oldRuntime;
    rmSync(dir, { recursive: true, force: true });
  }
});
