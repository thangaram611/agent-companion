import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PINNED_VERSION,
  CONTRACT_PATH,
  REGENERATE_COMMAND,
  SCHEMA_GENERATOR_ARGS,
  codexAppServerContract,
  codexVersionMismatchMessage,
  distillAppServerSchema,
  parseCodexVersion,
  routeNotification,
  routeRequest,
  serializeContract,
} from './codex-app-server-contract.mjs';

// ---------------------------------------------------------------------------
// Invariants of the committed fixture.
//
// These run with no codex installed, which is the point: they are what test the
// classification itself. The drift test below proves the fixture still matches
// the CLI; these prove the fixture says what the broker was designed against.
// Every number and name here was measured on codex-cli 0.147.0; only the 95/70
// headline is echoed in docs/RELIABILITY_REMEDIATION.md (§1's findings table) —
// the census below is recorded here and in the fixture, nowhere else.
// ---------------------------------------------------------------------------

const contract = codexAppServerContract();

const byRouting = (routing) => contract.serverNotifications.filter((e) => e.routing === routing);
const methodsOf = (entries) => entries.map((e) => e.method).sort();

// Named, not just counted: a hand-edit or a botched merge that swaps two
// notifications between `global` and `threadId` keeps every count intact, and on
// a machine without codex the drift test skips — so the counts alone would let a
// global notification be delivered to a thread id that does not exist.
const GLOBAL_METHODS = [
  'account/login/completed',
  'account/rateLimits/updated',
  'account/updated',
  'app/list/updated',
  'command/exec/outputDelta',
  'configWarning',
  'deprecationNotice',
  'externalAgentConfig/import/completed',
  'externalAgentConfig/import/progress',
  'fs/changed',
  'fuzzyFileSearch/sessionCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'process/exited',
  'process/outputDelta',
  'remoteControl/status/changed',
  'skills/changed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
];

test('the pinned contract is the 0.147.0 census', () => {
  assert.equal(CODEX_PINNED_VERSION, '0.147.0');
  assert.equal(contract.clientMethods.length, 95);
  assert.equal(contract.serverNotifications.length, 70);
  assert.equal(byRouting('threadId').length, 51);
  assert.equal(byRouting('nested').length, 1);
  assert.equal(byRouting('global').length, 18);
  assert.deepEqual(methodsOf(byRouting('global')), GLOBAL_METHODS);
});

test('exactly three notifications declare their thread id optional', () => {
  // These three type `threadId` as `["string","null"]` and leave it out of
  // `required` — the schema's own words for `warning` are "Optional thread
  // target when the warning applies to a specific thread". Recording them as
  // unconditionally thread-routed would make a legal, thread-less `warning` look
  // like drift; erasing the distinction would hide a codex bump that makes one
  // of them mandatory (or makes a mandatory one optional).
  assert.deepEqual(methodsOf(contract.serverNotifications.filter((e) => e.optional)), [
    'mcpServer/oauthLogin/completed',
    'mcpServer/startupStatus/updated',
    'warning',
  ]);
  for (const entry of contract.serverNotifications.filter((e) => e.optional)) {
    assert.equal(entry.routing, 'threadId', entry.method);
    assert.equal(entry.key, 'params.threadId', entry.method);
  }
});

test('thread/started is thread-routable, nested at params.thread.id', () => {
  // It is the 52nd thread-routable notification and the only one that does not
  // carry a flat `threadId` — classify it as global and every thread's first
  // event lands nowhere.
  const started = contract.serverNotifications.find((e) => e.method === 'thread/started');
  assert.deepEqual(started, {
    method: 'thread/started',
    routing: 'nested',
    key: 'params.thread.id',
    optional: false,
  });
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
  for (const request of contract.serverRequests) {
    if (request.threadScoped) assert.match(request.key, /^params\./, request.method);
    else assert.equal(request.key, null, request.method);
    assert.equal(request.optional, false, request.method);
  }
});

test('the two legacy approval requests carry their id at params.conversationId', () => {
  // The whole reason the key is recorded per request rather than assumed: read
  // `params.threadId` off one of these and the approval can never be matched to
  // its job, so it is never answered and the turn blocks until it times out.
  for (const legacy of ['applyPatchApproval', 'execCommandApproval']) {
    const entry = contract.serverRequests.find((r) => r.method === legacy);
    assert.deepEqual(entry, { method: legacy, threadScoped: true, key: 'params.conversationId', optional: false });
  }
  // Everything else does spell it `threadId` — which is what makes the pair easy
  // to miss by hand.
  for (const request of contract.serverRequests) {
    if (!request.threadScoped || request.method.endsWith('Approval')) continue;
    assert.equal(request.key, 'params.threadId', request.method);
  }
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

test('the fixture on disk is serialized the way the distiller writes it', () => {
  // Guards the serialization, not the content: a fixture that drifts from the
  // generator's own byte layout makes every future drift diff noisy.
  //
  // Round-tripping alone cannot see key order — `JSON.parse` keeps the file's
  // own insertion order, so re-serializing a reordered file reproduces it, and
  // `deepEqual` in the drift test is order-insensitive too. So the order is
  // asserted outright, exactly as `distillAppServerSchema` writes it.
  assert.equal(readFileSync(CONTRACT_PATH, 'utf8'), serializeContract(contract));
  assert.deepEqual(Object.keys(contract), [
    'codexVersion',
    'clientMethods',
    'serverNotifications',
    'serverRequests',
    'threadStatusTypes',
    'threadActiveFlags',
    'approvalDecisions',
  ]);
  for (const entry of contract.serverNotifications) {
    assert.deepEqual(Object.keys(entry), ['method', 'routing', 'key', 'optional'], entry.method);
  }
  for (const entry of contract.serverRequests) {
    assert.deepEqual(Object.keys(entry), ['method', 'threadScoped', 'key', 'optional'], entry.method);
  }
  const sorted = (list) => assert.deepEqual(list, [...list].sort());
  sorted(contract.clientMethods);
  sorted(contract.serverNotifications.map((e) => e.method));
  sorted(contract.serverRequests.map((e) => e.method));
  sorted(Object.keys(contract.approvalDecisions));
  for (const [method, vocabulary] of Object.entries(contract.approvalDecisions)) {
    assert.deepEqual(Object.keys(vocabulary), ['field', 'decisions'], method);
    sorted(vocabulary.decisions);
  }
});

// ---------------------------------------------------------------------------
// The routing table in use.
// ---------------------------------------------------------------------------

test('routeNotification resolves flat, nested, global and unknown methods', () => {
  assert.deepEqual(
    routeNotification('item/agentMessage/delta', { threadId: 't-1', delta: 'hi' }),
    { routing: 'threadId', threadId: 't-1', optional: false },
  );
  assert.deepEqual(
    routeNotification('thread/started', { thread: { id: 't-2', path: '/rollout.jsonl' } }),
    { routing: 'nested', threadId: 't-2', optional: false },
  );
  assert.deepEqual(routeNotification('skills/changed', {}), { routing: 'global', threadId: null, optional: false });
  // Drift must be distinguishable from a known-global notification: a method
  // this contract has never seen is not something to fan out silently.
  assert.deepEqual(
    routeNotification('thread/teleported', { threadId: 't-3' }),
    { routing: 'unknown', threadId: null, optional: false },
  );
  // A thread-routable method whose id is missing yields null, never the
  // envelope's other fields — and `optional` says whether that absence is legal
  // (a warning about nothing in particular) or drift (an id that moved).
  assert.deepEqual(
    routeNotification('thread/started', { thread: {} }),
    { routing: 'nested', threadId: null, optional: false },
  );
  assert.deepEqual(
    routeNotification('warning', { message: 'disk is nearly full' }),
    { routing: 'threadId', threadId: null, optional: true },
  );
  assert.deepEqual(
    routeNotification('warning', { threadId: 't-4', message: 'this turn is degraded' }),
    { routing: 'threadId', threadId: 't-4', optional: true },
  );
});

test('routeRequest reads each request from its own recorded key', () => {
  assert.deepEqual(
    routeRequest('item/commandExecution/requestApproval', { threadId: 't-1', itemId: 'i-1' }),
    { routing: 'threadId', threadId: 't-1', optional: false },
  );
  // The trap this accessor exists for: the legacy pair is thread-scoped, but the
  // id is under the pre-rename name. Reading `params.threadId` here returns
  // undefined and the approval is never answered.
  assert.deepEqual(
    routeRequest('execCommandApproval', { conversationId: 't-2', callId: 'c-1' }),
    { routing: 'threadId', threadId: 't-2', optional: false },
  );
  assert.deepEqual(
    routeRequest('applyPatchApproval', { conversationId: 't-3', callId: 'c-2' }),
    { routing: 'threadId', threadId: 't-3', optional: false },
  );
  assert.deepEqual(routeRequest('attestation/generate', {}), { routing: 'global', threadId: null, optional: false });
  assert.deepEqual(
    routeRequest('thread/handshake', { threadId: 't-4' }),
    { routing: 'unknown', threadId: null, optional: false },
  );
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
    const regenerated = distillAppServerSchema(schemaDir, installedVersion);
    assert.deepEqual(
      regenerated,
      contract,
      `codex-cli ${installedVersion} no longer matches the committed contract. `
      + `Review the protocol change against the broker's routing before accepting it, then: ${REGENERATE_COMMAND}`,
    );
    // `deepEqual` ignores key order, so the bytes are compared too: same content
    // in a different order still means the next regeneration rewrites the file
    // and buries the real protocol change in a reordering diff.
    assert.equal(
      readFileSync(CONTRACT_PATH, 'utf8'),
      serializeContract(regenerated),
      `the committed fixture holds the right content in the wrong byte layout — run: ${REGENERATE_COMMAND}`,
    );
  } finally {
    rmSync(schemaDir, { recursive: true, force: true });
  }
});
