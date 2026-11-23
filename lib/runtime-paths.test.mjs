import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runtimeDir,
  bridgeLogFile,
  promptJsonlDir,
} from './runtime-paths.mjs';

test('runtime paths default under a private override root', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-runtime-paths-'));
  const oldRuntime = process.env.AGENT_RUNTIME_DIR;
  process.env.AGENT_RUNTIME_DIR = dir;
  try {
    assert.equal(runtimeDir(), dir);
    assert.equal(bridgeLogFile(), join(dir, 'agent-bridge.log'));
    assert.equal(promptJsonlDir(), join(dir, 'prompts'));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    if (oldRuntime === undefined) delete process.env.AGENT_RUNTIME_DIR;
    else process.env.AGENT_RUNTIME_DIR = oldRuntime;
    rmSync(dir, { recursive: true, force: true });
  }
});
