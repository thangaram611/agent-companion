// Import this FIRST in any suite whose static imports reach lib/state.mjs or
// lib/runtime-paths.mjs — directly or through validation.mjs, profile-registry,
// target-registry, onboard.mjs, the daemons, or server.mjs.
//
//   import '../test/sandbox-home.mjs';
//   import { validateAgentArgs } from './validation.mjs';
//
// ESM evaluates a module's imports in statement order, so this runs before
// state.mjs binds BASE_DIR at import — which is the only moment that matters,
// and the reason a `process.env.X = …` line in the suite body is too late for
// a static import (it runs after every import has already evaluated). Suites
// that `await import()` after setting their own env keep working: `??=` leaves
// a value that is already set alone.
//
// Why a sandbox is mandatory: under `node --test`, lib/host.mjs's
// refuseRealHomeUnderTest throws on any path under the operator's real
// account home (see test/runtime-sandbox-guard.test.mjs), because a suite
// that read or wrote live state kept the shared codex broker alive for 30 min
// per run (measured 2026-08-28). Everything here lands under os.tmpdir().
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

export const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'ac-sandbox-home-'));
process.env.AGENT_COMPANION_HOME ??= join(SANDBOX_HOME, 'agent-companion');
process.env.AGENT_RUNTIME_DIR ??= join(SANDBOX_HOME, 'runtime');
test.after(() => rmSync(SANDBOX_HOME, { recursive: true, force: true }));
