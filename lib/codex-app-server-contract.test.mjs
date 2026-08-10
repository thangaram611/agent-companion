import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_APP_SERVER_CONTRACT as contract,
  CODEX_PINNED_VERSION,
  CONTRACT_PATH,
  REGENERATE_COMMAND,
  SCHEMA_GENERATOR_ARGS,
  codexVersionMismatchMessage,
  distillAppServerSchema,
  parseCodexVersion,
  routeNotification,
  serializeContract,
} from './codex-app-server-contract.mjs';

// ---------------------------------------------------------------------------
// Invariants of the committed fixture.
//
// These run with no codex installed, which is the point: they are what test the
// classification itself. The drift test below proves the fixture still matches
// the CLI; these prove the fixture says what the broker was designed against.
// Every number here was measured on codex-cli 0.147.0 and is recorded in
// docs/RELIABILITY_REMEDIATION.md §2.
// ---------------------------------------------------------------------------

const byRouting = (routing) => contract.serverNotifications.filter((e) => e.routing === routing);

test('the pinned contract is the 0.147.0 census', () => {
  assert.equal(CODEX_PINNED_VERSION, '0.147.0');
  assert.equal(contract.clientMethods.length, 95);
  assert.equal(contract.serverNotifications.length, 70);
  assert.equal(byRouting('threadId').length, 51);
  assert.equal(byRouting('nested').length, 1);
  assert.equal(byRouting('global').length, 18);
});

test('thread/started is thread-routable, nested at params.thread.id', () => {
  // It is the 52nd thread-routable notification and the only one that does not
  // carry a flat `threadId` — classify it as global and every thread's first
  // event lands nowhere.
  const started = contract.serverNotifications.find((e) => e.method === 'thread/started');
  assert.deepEqual(started, { method: 'thread/started', routing: 'nested', key: 'params.thread.id' });
  assert.equal(byRouting('nested')[0].method, 'thread/started');
});

test('every thread-routable notification records the key to read it from', () => {
  for (const entry of contract.serverNotifications) {
    if (entry.routing === 'global') assert.equal(entry.key, null, entry.method);
    else assert.match(entry.key, /^params\./, entry.method);
  }
  for (const entry of byRouting('threadId')) assert.equal(entry.key, 'params.threadId', entry.method);
});

test('exactly two server requests are not thread-scoped', () => {
  assert.equal(contract.serverRequests.length, 10);
  const unscoped = contract.serverRequests.filter((r) => !r.threadScoped).map((r) => r.method);
  // The legacy pair (applyPatchApproval / execCommandApproval) still spells the
  // field `conversationId`, but the schema types it `ThreadId` — so they are
  // thread-scoped and only these two genuinely are not.
  assert.deepEqual(unscoped, ['account/chatgptAuthTokens/refresh', 'attestation/generate']);
});

test('ThreadStatus is the four-variant tagged union with two active flags', () => {
  assert.deepEqual(contract.threadStatusTypes, ['active', 'idle', 'notLoaded', 'systemError']);
  assert.deepEqual(contract.threadActiveFlags, ['waitingOnApproval', 'waitingOnUserInput']);
});

test('approval vocabularies are per-method, and carry the field to answer in', () => {
  // Answering with another method's words — or in another method's field —
  // reads as a denial, so both halves are contract.
  assert.deepEqual(contract.approvalDecisions['item/commandExecution/requestApproval'], {
    field: 'decision',
    decisions: ['accept', 'acceptForSession', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment', 'cancel', 'decline'],
  });
  assert.deepEqual(contract.approvalDecisions['item/fileChange/requestApproval'], {
    field: 'decision',
    decisions: ['accept', 'acceptForSession', 'cancel', 'decline'],
  });
  for (const legacy of ['execCommandApproval', 'applyPatchApproval']) {
    assert.deepEqual(contract.approvalDecisions[legacy].decisions, [
      'abort', 'approved', 'approved_execpolicy_amendment', 'approved_for_session',
      'denied', 'network_policy_amendment', 'timed_out',
    ], legacy);
  }
  assert.equal(contract.approvalDecisions['mcpServer/elicitation/request'].field, 'action');
  // Permissions answers with a grant, not a choice, so it has no vocabulary.
  assert.equal(contract.approvalDecisions['item/permissions/requestApproval'], undefined);
});

test('the fixture on disk is exactly what the distiller emits', () => {
  // Guards the serialization, not the content: a hand-edit that reorders keys
  // or drops the trailing newline would make every future drift diff noisy.
  assert.equal(readFileSync(CONTRACT_PATH, 'utf8'), serializeContract(contract));
});

// ---------------------------------------------------------------------------
// The routing table in use.
// ---------------------------------------------------------------------------

test('routeNotification resolves flat, nested, global and unknown methods', () => {
  assert.deepEqual(
    routeNotification('item/agentMessage/delta', { threadId: 't-1', delta: 'hi' }),
    { routing: 'threadId', threadId: 't-1' },
  );
  assert.deepEqual(
    routeNotification('thread/started', { thread: { id: 't-2', path: '/rollout.jsonl' } }),
    { routing: 'nested', threadId: 't-2' },
  );
  assert.deepEqual(routeNotification('skills/changed', {}), { routing: 'global', threadId: null });
  // Drift must be distinguishable from a known-global notification: a method
  // this contract has never seen is not something to fan out silently.
  assert.deepEqual(routeNotification('thread/teleported', { threadId: 't-3' }), { routing: 'unknown', threadId: null });
  // A thread-routable method whose id is missing yields null, never the
  // envelope's other fields.
  assert.deepEqual(routeNotification('thread/started', { thread: {} }), { routing: 'nested', threadId: null });
});

test('parseCodexVersion reads the version, or says it could not', () => {
  assert.equal(parseCodexVersion('codex-cli 0.147.0'), '0.147.0');
  assert.equal(parseCodexVersion('codex-cli 0.148.0-alpha.1\n'), '0.148.0-alpha.1');
  assert.equal(parseCodexVersion('some other binary'), null);
  assert.equal(parseCodexVersion(''), null);
});

test('the mismatch message names both versions and the fix', () => {
  const message = codexVersionMismatchMessage('0.148.0');
  assert.match(message, /0\.147\.0/);
  assert.match(message, /0\.148\.0/);
  assert.ok(message.includes(REGENERATE_COMMAND), message);
  assert.match(codexVersionMismatchMessage(null), /unrecognised codex version/);
});

// ---------------------------------------------------------------------------
// Drift guard — needs the pinned codex.
//
// Skipped when codex is absent so CI without it stays green; FAILED (not
// skipped) when a different codex is installed, because the whole hazard is a
// schema that moved without anyone looking.
// ---------------------------------------------------------------------------

const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// Absent is a skip; present-but-unreadable is a failure. Only "there is no codex
// here" is safe to pass over — a codex that will not say what it is cannot be
// checked against the pin, and quietly skipping would retire the guard on
// exactly the machine that needs it. That distinction is why this spawns
// directly instead of reusing probeCommand, which collapses "not installed" and
// "ran and failed" into the same `{ok:false}`.
function probeCodex() {
  const result = spawnSync(CODEX_BIN, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ENOENT') return { present: false, version: null };
  return { present: true, version: result.status === 0 ? parseCodexVersion(result.stdout) : null };
}

const installed = probeCodex();

test('the committed contract still matches the installed codex', {
  skip: installed.present ? false : `${CODEX_BIN} is not installed; nothing to drift against`,
}, () => {
  const installedVersion = installed.version;
  assert.equal(installedVersion, CODEX_PINNED_VERSION, codexVersionMismatchMessage(installedVersion));

  const schemaDir = mkdtempSync(path.join(tmpdir(), 'codex-app-server-schema-'));
  try {
    const result = spawnSync(CODEX_BIN, [...SCHEMA_GENERATOR_ARGS, schemaDir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(
      distillAppServerSchema(schemaDir, installedVersion),
      contract,
      `codex-cli ${installedVersion} no longer matches the committed contract. `
      + `Review the protocol change against the broker's routing before accepting it, then: ${REGENERATE_COMMAND}`,
    );
  } finally {
    rmSync(schemaDir, { recursive: true, force: true });
  }
});
