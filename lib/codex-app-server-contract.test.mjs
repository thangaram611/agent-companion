import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CODEX_PINNED_VERSION,
  CONTRACT_PATH,
  REGENERATE_COMMAND,
  SCHEMA_GENERATOR_ARGS,
  clientRequestContract,
  codexAppServerContract,
  codexVersionMismatchMessage,
  compareContracts,
  connectionScopedNotificationMethods,
  contractDriftMessage,
  contractMatchMessage,
  contractUnverifiedMessage,
  contractViolation,
  distillAppServerSchema,
  parseCodexVersion,
  parseFieldTag,
  routeNotification,
  routeRequest,
  serializeContract,
  serverFrameViolation,
  THREAD_OWNERSHIP_METHODS,
  threadItemViolation,
  unhandledMethodError,
} from './codex-app-server-contract.mjs';

// ---------------------------------------------------------------------------
// Invariants of the committed fixture.
//
// These run with no codex installed, which is the point: they are what test the
// classification itself. The drift test below proves the fixture still matches
// the CLI; these prove the fixture says what the broker was designed against.
//
// They pin NAMES, not counts. A count breaks on every codex upgrade that adds a
// notification, which is most of them (0.147.0 → 0.150.1 added nine), and says
// nothing about which one moved. A named routing list breaks only when a method
// changes class — and a NEW global method has to be added here by hand, which is
// the review the design wants: "is this really global, or does it carry a thread
// id under a key the distiller missed?" New `threadId` notifications need no
// edit; routing them by the id they carry is correct by construction.
// Measured on codex-cli 0.147.0 and re-measured on 0.150.1.
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
  'configWarning',
  'deprecationNotice',
  'externalAgentConfig/import/completed',
  'externalAgentConfig/import/progress',
  'fuzzyFileSearch/sessionCompleted',
  'fuzzyFileSearch/sessionUpdated',
  'project/changed',
  'remoteControl/status/changed',
  'skills/changed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
];

// The one notification whose thread id is nested (`params.thread.id`). A second
// entry here would mean the distiller found another `thread` sub-object carrying
// the id — which is a routing decision, so it is pinned by name.
const NESTED_METHODS = ['thread/started'];

// Connection-scoped: no thread, but an owner key (`subscriptionId`,
// `processId`, `processHandle`, `watchId`) naming the request — and so the
// connection — that created it. Codex delivers each to that ONE connection
// (read at rust-v0.150.1: mcp_event_stream.rs, command_exec.rs,
// process_exec_processor.rs, fs_watch.rs), which through a shared broker is
// every bridge and so no bridge. The broker declines them at initialize and
// drops any that arrive. `fuzzyFileSearch/session*`, `account/login/completed`
// and `externalAgentConfig/import/*` carry owner-looking keys too and are NOT
// here: codex genuinely broadcasts those.
const CONNECTION_KEYS = {
  'command/exec/outputDelta': 'params.processId',
  'fs/changed': 'params.watchId',
  'mcpServer/event/stream/notification': 'params.subscriptionId',
  'process/exited': 'params.processHandle',
  'process/outputDelta': 'params.processHandle',
};
const CONNECTION_METHODS = Object.keys(CONNECTION_KEYS);

// Server→client requests are what the adapter has to ANSWER, so a new one is a
// review item (does the `never` approval policy suppress it, or must the bridge
// reply?). Pinned by name for that reason.
const SERVER_REQUEST_METHODS = [
  'account/chatgptAuthTokens/refresh',
  'applyPatchApproval',
  'attestation/generate',
  'execCommandApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/call',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
];

// ThreadItem variants are what the accumulator has to CLASSIFY, so likewise.
const THREAD_ITEM_VARIANTS = [
  'agentMessage', 'collabAgentToolCall', 'commandExecution', 'contextCompaction', 'dynamicToolCall',
  'enteredReviewMode', 'exitedReviewMode', 'fileChange', 'hookPrompt', 'imageGeneration', 'imageView',
  'mcpToolCall', 'plan', 'reasoning', 'sleep', 'subAgentActivity', 'userMessage', 'webSearch',
];

test('the pinned contract routes every notification the way the broker was built against', () => {
  // Provenance is a semver, whatever it is; the drift test below is what ties
  // it to a binary.
  assert.match(CODEX_PINNED_VERSION, /^\d+\.\d+\.\d+/);
  assert.deepEqual(methodsOf(byRouting('global')), GLOBAL_METHODS);
  assert.deepEqual(methodsOf(byRouting('nested')), NESTED_METHODS);
  assert.deepEqual(methodsOf(byRouting('connection')), CONNECTION_METHODS);
  // Per method, not "one of the four": the owner key is what the WARN names.
  assert.deepEqual(Object.fromEntries(byRouting('connection').map((e) => [e.method, e.key])), CONNECTION_KEYS);
  // The rule is for notifications only; a server→client request never lands
  // in this class even when it carries an owner-looking key.
  for (const request of contract.serverRequests) {
    assert.ok(!/^params\.(subscriptionId|processId|processHandle|watchId)$/.test(request.key || ''), request.method);
  }
  // Everything else routes flat by `params.threadId` — asserted by exhaustion so
  // a fifth routing class cannot appear without being named here.
  const classified = new Set([...GLOBAL_METHODS, ...NESTED_METHODS, ...CONNECTION_METHODS]);
  for (const entry of contract.serverNotifications) {
    if (classified.has(entry.method)) continue;
    assert.equal(entry.routing, 'threadId', entry.method);
  }
  assert.ok(byRouting('threadId').length > byRouting('global').length, 'thread-routed events are the bulk of the protocol');
});

test('connection-scoped notifications resolve an owner, never a thread, and are the handshake opt-out list', () => {
  assert.deepEqual(connectionScopedNotificationMethods(), CONNECTION_METHODS);
  const stream = routeNotification('mcpServer/event/stream/notification', {
    subscriptionId: 'sub-1', notification: { method: 'notifications/events/event', params: {} },
  });
  assert.deepEqual(stream, { routing: 'connection', threadId: null, owner: 'sub-1', optional: false });
  const exec = routeNotification('command/exec/outputDelta', { processId: 'p-9', stream: 'stdout', deltaBase64: '', capReached: false });
  assert.deepEqual(exec, { routing: 'connection', threadId: null, owner: 'p-9', optional: false });
  assert.equal(routeNotification('process/exited', { processHandle: 'h-2', exitCode: 0, stdout: '', stderr: '', stdoutCapReached: false, stderrCapReached: false }).owner, 'h-2');
  assert.equal(routeNotification('process/outputDelta', { processHandle: 'h-3', stream: 'stderr', deltaBase64: '', capReached: false }).owner, 'h-3');
  assert.equal(routeNotification('fs/changed', { watchId: 'w-4', changedPaths: [] }).owner, 'w-4');
  // Thread-routed and global answers are unchanged in shape: `owner` is null.
  assert.equal(routeNotification('turn/started', { threadId: 'T', turn: {} }).owner, null);
  assert.equal(routeNotification('skills/changed', {}).owner, null);
  assert.equal(routeNotification('never/heard/of', {}).owner, null);
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
  // It is the 59th thread-routable notification and the only one that does not
  // carry a flat `threadId` — classify it as global and every thread's first
  // event lands nowhere.
  const started = contract.serverNotifications.find((e) => e.method === 'thread/started');
  assert.deepEqual(started, {
    method: 'thread/started',
    routing: 'nested',
    key: 'params.thread.id',
    optional: false,
    // The whole params object, which is what makes the nesting legible rather
    // than asserted: the id is under `thread` because the notification carries
    // the entire `Thread`, not a bare id.
    params: { thread: 'Thread' },
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
  assert.deepEqual(methodsOf(contract.serverRequests), SERVER_REQUEST_METHODS);
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

// ---------------------------------------------------------------------------
// The server→client shapes.
//
// The half that had no guard at all until five wrong field spellings shipped at
// once, each with a green unit test: a reader that names a field the server does
// not send gets `undefined`, and a hand-written fixture spelling it the same
// wrong way makes the read look proven. What is asserted below is exactly the
// six the adapter got wrong, so a codex bump that moves one of them fails here.
// ---------------------------------------------------------------------------

test('every delta notification spells its payload `delta`, required', () => {
  for (const method of [
    'item/agentMessage/delta',
    'item/reasoning/textDelta',
    'item/reasoning/summaryTextDelta',
    'item/commandExecution/outputDelta',
  ]) {
    const entry = contract.serverNotifications.find((e) => e.method === method);
    assert.equal(entry.params.delta, 'string', method);
    assert.equal(entry.params.itemId, 'string', method);
    // …and none of the three spellings the accumulator used to read exists.
    for (const invented of ['chunk', 'output', 'text']) {
      assert.equal(invented in entry.params, false, `${method} does not carry \`${invented}\``);
    }
  }
});

test('the error notification carries a TurnError, a turn id and willRetry', () => {
  const error = contract.serverNotifications.find((e) => e.method === 'error');
  assert.deepEqual(error.params, {
    error: 'TurnError', threadId: 'string', turnId: 'string', willRetry: 'boolean',
  });
  // The message is one level down; there is no flat `params.message` — that
  // spelling belongs to the exec stream's `error` event.
  assert.equal(contract.structuredTypes.TurnError.message, 'string');
});

test('a Turn carries its status, its items and a TurnError, and no `failure`', () => {
  const turn = contract.structuredTypes.Turn;
  assert.equal(turn.id, 'string');
  assert.equal(turn.items, 'ThreadItem[]');
  assert.equal(turn.error, 'TurnError?');
  assert.equal('failure' in turn, false);
  // TurnStatus, pinned by being part of the shape rather than by a table of its
  // own: `inProgress` gates every turn-id resolution in the adapter and the
  // bridge, and `interrupted`/`completed`/`failed` decide the terminal verdict.
  assert.deepEqual(turn.status, 'enum:completed|interrupted|failed|inProgress');
});

test('the ThreadItem union is the pinned variant list, and `error` is not one of them', () => {
  const variants = Object.keys(contract.threadItems);
  assert.deepEqual([...variants].sort(), THREAD_ITEM_VARIANTS);
  assert.equal(variants.includes('error'), false);
  assert.equal(variants.includes('todoList'), false);
  // The four the accumulator reads, with the fields it reads them by.
  assert.equal(contract.threadItems.agentMessage.phase, 'enum:commentary|final_answer?');
  assert.deepEqual(contract.threadItems.reasoning, {
    content: 'string[]?', id: 'string', summary: 'string[]?', type: 'enum:reasoning',
  });
  assert.equal(contract.threadItems.mcpToolCall.arguments, 'any');
  assert.equal('input' in contract.threadItems.mcpToolCall, false);
  assert.equal(contract.threadItems.fileChange.changes, 'FileUpdateChange[]');
  assert.equal('files' in contract.threadItems.fileChange, false);
});

test('a file change names its path and a TAGGED kind, not a bare word', () => {
  // The one nested read the digest depends on: `server.mjs` builds "Files
  // touched" from `tc.input.path`, and `kind` is an object here where the exec
  // side has a string.
  assert.deepEqual(contract.structuredTypes.FileUpdateChange, {
    diff: 'string', kind: 'PatchChangeKind', path: 'string',
  });
  assert.deepEqual(contract.structuredTypes.PatchChangeKind, [
    { type: 'enum:add' },
    { type: 'enum:delete' },
    { move_path: 'string?', type: 'enum:update' },
  ]);
});

test('the structured types are the required-field closure, and nothing wider', () => {
  // The rule, asserted so a future widening is a deliberate edit: seeded from
  // the thread-routed notifications and the ThreadItem variants, closed over
  // REQUIRED fields only. Following optional ones instead pulls in 66 of the
  // dump's 114 object types for no gain — a builder can simply omit an optional
  // sub-object, so its shape is never needed to construct a legal frame.
  // (No count: the closure is asserted structurally below, and a count only
  // ever broke on codex upgrades that added a required sub-type.)
  assert.equal('ThreadItem' in contract.structuredTypes, false, 'ThreadItem has its own top-level map');
  // Reachable only through optional fields, so deliberately absent.
  for (const optionalOnly of ['MemoryCitation', 'McpToolCallResult', 'GitInfo', 'WebSearchAction']) {
    assert.equal(optionalOnly in contract.structuredTypes, false, optionalOnly);
  }
  // Every named type a recorded shape requires IS recorded, or the builders
  // cannot construct the frame that needs it.
  const required = new Set();
  const collect = (shape) => {
    if (Array.isArray(shape)) { for (const alt of shape) if (typeof alt !== 'string') collect(alt); return; }
    for (const tag of Object.values(shape)) {
      const { optional, named } = parseFieldTag(tag);
      if (!optional && named) required.add(named);
    }
  };
  for (const shape of Object.values(contract.structuredTypes)) collect(shape);
  for (const shape of Object.values(contract.threadItems)) collect(shape);
  for (const name of required) {
    if (name === 'ThreadItem') continue;
    assert.ok(contract.structuredTypes[name], `${name} is required by a recorded shape but has no shape of its own`);
  }
});

test('serverFrameViolation refuses the five spellings that shipped', () => {
  const ok = { threadId: 't-1', turnId: 'TURN1', itemId: 'i1', delta: 'ok' };
  assert.equal(serverFrameViolation('item/commandExecution/outputDelta', ok), null);
  assert.match(
    serverFrameViolation('item/commandExecution/outputDelta', { ...ok, chunk: 'ok' }),
    /carries `chunk`/,
  );
  // Missing-required is reported before unknown-field, the order the real server
  // deserializes in — so the flat `message` spelling shows up once the frame is
  // otherwise complete, which is how the frame builders present it.
  assert.match(
    serverFrameViolation('error', { threadId: 't-1', turnId: 'TURN1', willRetry: false }),
    /missing required field `error`/,
  );
  assert.match(
    serverFrameViolation('error', { threadId: 't-1', turnId: 'TURN1', willRetry: false, error: { message: 'boom' }, message: 'boom' }),
    /carries `message`/,
  );
  // Nested, and typed: a Turn is checked through to its items.
  assert.match(
    serverFrameViolation('turn/completed', { threadId: 't-1', turn: { id: 'T', status: 'done', items: [] } }),
    /status is `done`, which is not one of completed, interrupted, failed, inProgress/,
  );
  assert.match(
    serverFrameViolation('turn/completed', { threadId: 't-1', turn: { id: 'T', status: 'completed', items: [{ type: 'reasoning', id: 'r', text: 'x' }] } }),
    /items\[0\]: reasoning item carries `text`/,
  );
  // A method this pin has never seen has no contract to check — drift is the
  // caller's to report, exactly as on the client side.
  assert.equal(serverFrameViolation('broker/appServerDied', { code: 7 }), null);
});

test('an unknown field is refused even when it is spelt like an Object.prototype key', () => {
  // The shapes are JSON.parse output, so they inherit Object.prototype: a
  // `name in fields` test answers TRUE for twelve field names no schema
  // declares, and each of them would have walked through the unknown-field rule
  // that is the whole point of the check. No 0.147.0 field is spelt any of
  // them — this is the guarantee holding without depending on that.
  const ok = { threadId: 't-1', turnId: 'TURN1', itemId: 'i1', delta: 'ok' };
  for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.match(
      serverFrameViolation('item/agentMessage/delta', { ...ok, [inherited]: 'x' }),
      new RegExp(`carries \`${inherited}\``),
      inherited,
    );
  }
  assert.match(threadItemViolation({ type: 'agentMessage', id: 'm1', text: 'hi', toString: 'x' }), /carries `toString`/);
});

test('threadItemViolation names the variant list when the type does not exist', () => {
  assert.equal(threadItemViolation({ type: 'agentMessage', id: 'm1', text: 'hi' }), null);
  assert.match(
    threadItemViolation({ type: 'error', message: 'x' }),
    new RegExp(`not one of codex-cli ${CODEX_PINNED_VERSION.replace(/\./g, '\\.')}'s ${THREAD_ITEM_VARIANTS.length} ThreadItem variants`),
  );
  assert.match(threadItemViolation({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a', diff: 'd', kind: 'update' }] }),
    /changes\[0\]\.kind matches none of PatchChangeKind's 3 variants/);
  assert.equal(
    threadItemViolation({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: 'a', diff: 'd', kind: { type: 'update' } }] }),
    null,
  );
  assert.match(threadItemViolation({ type: 'commandExecution', id: 'i', command: 'ls', cwd: '/w', commandActions: [], status: 'completed', exitCode: '0' }),
    /exitCode must be a integer, not a string/);
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
  // (`approved_mcp_policy_amendment` arrived in 0.150.1. The adapter answers
  // none of these — `approvalPolicy: 'never'` is structural — so the list is a
  // fixture fact, not an adapter dependency.)
  for (const legacy of ['execCommandApproval', 'applyPatchApproval']) {
    assert.deepEqual(contract.approvalDecisions[legacy].decisions, [
      'abort', 'approved', 'approved_execpolicy_amendment', 'approved_for_session',
      'approved_mcp_policy_amendment', 'denied', 'network_policy_amendment', 'timed_out',
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
    'clientRequests',
    'serverNotifications',
    'serverRequests',
    'threadItems',
    'structuredTypes',
    'threadStatusTypes',
    'threadActiveFlags',
    'approvalDecisions',
  ]);
  const sorted = (list) => assert.deepEqual(list, [...list].sort());
  for (const entry of contract.serverNotifications) {
    assert.deepEqual(Object.keys(entry), ['method', 'routing', 'key', 'optional', 'params'], entry.method);
    if (entry.params) sorted(Object.keys(entry.params));
  }
  sorted(Object.keys(contract.threadItems));
  sorted(Object.keys(contract.structuredTypes));
  for (const [type, fields] of Object.entries(contract.threadItems)) sorted(Object.keys(fields), type);
  for (const entry of contract.serverRequests) {
    assert.deepEqual(Object.keys(entry), ['method', 'threadScoped', 'key', 'optional'], entry.method);
  }
  for (const entry of contract.clientRequests) {
    assert.deepEqual(Object.keys(entry), ['method', 'paramsRequired', 'required'], entry.method);
    sorted(entry.required);
  }
  sorted(contract.clientRequests.map((e) => e.method));
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
    { routing: 'threadId', threadId: 't-1', owner: null, optional: false },
  );
  assert.deepEqual(
    routeNotification('thread/started', { thread: { id: 't-2', path: '/rollout.jsonl' } }),
    { routing: 'nested', threadId: 't-2', owner: null, optional: false },
  );
  assert.deepEqual(routeNotification('skills/changed', {}), { routing: 'global', threadId: null, owner: null, optional: false });
  // Drift must be distinguishable from a known-global notification: a method
  // this contract has never seen is not something to fan out silently.
  assert.deepEqual(
    routeNotification('thread/teleported', { threadId: 't-3' }),
    { routing: 'unknown', threadId: null, owner: null, optional: false },
  );
  // A thread-routable method whose id is missing yields null, never the
  // envelope's other fields — and `optional` says whether that absence is legal
  // (a warning about nothing in particular) or drift (an id that moved).
  assert.deepEqual(
    routeNotification('thread/started', { thread: {} }),
    { routing: 'nested', threadId: null, owner: null, optional: false },
  );
  assert.deepEqual(
    routeNotification('warning', { message: 'disk is nearly full' }),
    { routing: 'threadId', threadId: null, owner: null, optional: true },
  );
  assert.deepEqual(
    routeNotification('warning', { threadId: 't-4', message: 'this turn is degraded' }),
    { routing: 'threadId', threadId: 't-4', owner: null, optional: true },
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

// ---------------------------------------------------------------------------
// Required params — the half of the contract the fakes enforce.
// ---------------------------------------------------------------------------

test('the two turn-control methods declare the ids the adapter used to omit', () => {
  // The whole defect: both fields are `required`, the adapter dropped them when
  // null, and every fake answered anyway. Measured against the real 0.147.0
  // server, the omission is an UNCONDITIONAL -32600 — so `agent_cancel` and
  // `agent_reply` failed on every app-server job.
  const steer = contract.clientRequests.find((e) => e.method === 'turn/steer');
  assert.deepEqual(steer, {
    method: 'turn/steer',
    paramsRequired: true,
    required: ['expectedTurnId', 'input', 'threadId'],
  });
  const interrupt = contract.clientRequests.find((e) => e.method === 'turn/interrupt');
  assert.deepEqual(interrupt, {
    method: 'turn/interrupt',
    paramsRequired: true,
    required: ['threadId', 'turnId'],
  });
});

test('contractViolation reproduces the server\'s own refusal, word for word', () => {
  // Measured on codex-cli 0.147.0 against an all-zero thread id, which never
  // reaches a thread lookup because deserialization refuses first:
  //   turn/steer     without expectedTurnId -> -32600 missing field `expectedTurnId`
  //   turn/interrupt without turnId         -> -32600 missing field `turnId`
  assert.deepEqual(
    contractViolation('turn/steer', { threadId: 't-1', input: [{ type: 'text', text: 'x' }] }),
    { code: -32600, message: 'Invalid request: missing field `expectedTurnId`' },
  );
  assert.deepEqual(
    contractViolation('turn/interrupt', { threadId: 't-1' }),
    { code: -32600, message: 'Invalid request: missing field `turnId`' },
  );
  // A present-but-null field is refused too — the real server says `invalid
  // type: null` there, but it is the same -32600 refusal of the same call, and
  // "the call never ran" is what a fake must reproduce.
  assert.deepEqual(
    contractViolation('turn/interrupt', { threadId: 't-1', turnId: null }),
    { code: -32600, message: 'Invalid request: missing field `turnId`' },
  );
  // Satisfied calls pass.
  assert.equal(contractViolation('turn/interrupt', { threadId: 't-1', turnId: 'TURN1' }), null);
  assert.equal(
    contractViolation('turn/steer', { threadId: 't-1', expectedTurnId: 'TURN1', input: [] }),
    null,
  );
});

test('the params object itself is required, per method', () => {
  // Measured: `thread/loaded/list` and `thread/start` both answer
  // `missing field \`params\`` when the key is absent, even though neither
  // params type has a required field of its own — 87 of the 95 requests list
  // `params` in the envelope's own `required`.
  assert.deepEqual(contractViolation('thread/loaded/list', undefined), {
    code: -32600, message: 'Invalid request: missing field `params`',
  });
  assert.equal(contractViolation('thread/loaded/list', {}), null);
  // The other 8 may legally be sent bare.
  assert.equal(contract.clientRequests.find((e) => e.method === 'account/logout').paramsRequired, false);
  assert.equal(contractViolation('account/logout', undefined), null);
});

test('every thread-ownership method is a client request this fixture still knows', () => {
  // The one export in this module that is hand-maintained rather than distilled,
  // and it is the fact the broker and the adapter BOTH key off — so a codex that
  // renames or drops one of these has to fail here, at the fixture, rather than
  // at runtime as events routed to nobody. The drift test below regenerates the
  // fixture from the installed binary; this ties the constant to it.
  for (const method of THREAD_OWNERSHIP_METHODS) {
    assert.ok(clientRequestContract(method), `${method} is no longer a client request`);
  }
  // Membership, spelled out. Adding a method here is a two-consumer decision
  // (subscribe + attach), never a drive-by.
  assert.deepEqual([...THREAD_OWNERSHIP_METHODS].sort(), ['thread/fork', 'thread/resume', 'thread/start']);
  // And the reason the set is not "responses that carry a thread": thread/read
  // does, and it is deliberately absent — reading a transcript is not owning the
  // thread it came from.
  assert.ok(clientRequestContract('thread/read'));
  assert.equal(THREAD_OWNERSHIP_METHODS.has('thread/read'), false);
});

test('a method outside the client-request union is not "requirement-free"', () => {
  // The broker's own methods and a fixture's `fake/*` are not client requests of
  // this protocol, so they have no requirements to check — but neither does a
  // method that DRIFTED out of the union, and both must be reported the same
  // way (null contract, not an empty one) so a caller can tell them apart from
  // a request that genuinely requires nothing.
  assert.equal(clientRequestContract('broker/status'), null);
  assert.equal(clientRequestContract('fake/emit'), null);
  assert.equal(contractViolation('broker/subscribe', {}), null);
  assert.deepEqual(clientRequestContract('thread/read'), {
    method: 'thread/read', paramsRequired: true, required: ['threadId'],
  });
});

test('a method no fake can answer is refused — without reciting an inventory the fixture lacks', () => {
  const refusal = unhandledMethodError('turn/interupt');
  assert.equal(refusal.code, -32600);
  assert.match(refusal.message, /unknown variant `turn\/interupt`/);

  // The measurement that decides the wording. The real server's refusal ends
  // `expected one of \`initialize\`, …` and enumerates 136 variants — but its own
  // `generate-json-schema` publishes 95 of them, so 41 methods the binary
  // answers for real are absent here. `thread/turns/list` is one of them, and a
  // fake reciting this fixture as "the server's inventory" would refuse a call
  // the server would have served.
  assert.equal(contract.clientRequests.length, 95);
  assert.equal(clientRequestContract('thread/turns/list'), null);
  assert.ok(!refusal.message.includes('expected one of'), refusal.message);
  // What it must say instead: the fake has no faithful answer. Both classes —
  // the fiction the server refuses and the real method the fixture never
  // modelled — are the same failure for a test, and neither is a success.
  assert.match(refusal.message, /no faithful answer/);
});

test('parseCodexVersion reads the version, or says it could not', () => {
  assert.equal(parseCodexVersion('codex-cli 0.147.0'), '0.147.0');
  assert.equal(parseCodexVersion('codex-cli 0.148.0-alpha.1\n'), '0.148.0-alpha.1');
  assert.equal(parseCodexVersion('some other binary'), null);
  assert.equal(parseCodexVersion(''), null);
});

test('the version-skew note names both versions and says the version alone decides nothing', () => {
  const message = codexVersionMismatchMessage('9.9.9');
  assert.ok(message.includes(CODEX_PINNED_VERSION), message);
  assert.match(message, /9\.9\.9/);
  assert.match(message, /version alone proves nothing/);
  assert.match(codexVersionMismatchMessage(null), /unrecognised codex version/);
});

// ---------------------------------------------------------------------------
// Contract comparison — the guard that replaced the version pin.
// ---------------------------------------------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));

test('compareContracts: the same contract under a different version is identical', () => {
  const live = clone(contract);
  live.codexVersion = '9.9.9';
  assert.deepEqual(compareContracts(contract, live), { identical: true, routing: [], removed: [], added: [], changed: [] });
  // Key order is not content: a reordered entry list is still identical …
  live.serverNotifications.reverse();
  assert.equal(compareContracts(contract, live).identical, true);
  // … and so are reordered keys INSIDE an entry, at any depth.
  const delta = live.serverNotifications.find((n) => n.method === 'item/agentMessage/delta');
  const reorderedParams = Object.fromEntries(Object.entries(delta.params).reverse());
  live.serverNotifications[live.serverNotifications.indexOf(delta)] = { ...delta, params: reorderedParams };
  const agentMessage = Object.fromEntries(Object.entries(live.threadItems.agentMessage).reverse());
  live.threadItems = { ...live.threadItems, agentMessage };
  assert.equal(compareContracts(contract, live).identical, true);
});

test('compareContracts: a duplicate method entry is a change even when its last copy matches', () => {
  const live = clone(contract);
  live.serverNotifications.push(clone(live.serverNotifications[0]));
  const diff = compareContracts(contract, live);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.changed, ['serverNotifications: duplicate method entries in the live contract']);
  assert.deepEqual(diff.added, []);
});

test('compareContracts classifies additions, removals, routing moves and shape changes — and routing wins', () => {
  const live = clone(contract);
  // added: a notification the pin has never seen
  live.serverNotifications.push({ method: 'thread/brandNew', routing: 'threadId', key: 'params.threadId', optional: false, params: { threadId: 'string' } });
  // removed: a client request the adapter may still send
  live.clientRequests = live.clientRequests.filter((r) => r.method !== 'turn/steer');
  // routing moved AND shape changed on the same entry: reported as routing, once
  const delta = live.serverNotifications.find((n) => n.method === 'item/agentMessage/delta');
  delta.routing = 'global';
  delta.key = null;
  delta.params = { text: 'string' };
  // shape only: a widened enum on a global notification
  const account = live.serverNotifications.find((n) => n.method === 'account/updated');
  account.params.planType += '|galactic';
  // a server request changing scope is a routing move too
  const permissions = live.serverRequests.find((r) => r.method === 'item/permissions/requestApproval');
  permissions.threadScoped = false;
  permissions.key = null;
  // and a non-method section: a new ThreadItem variant
  live.threadItems.hologram = { id: 'string', type: 'enum:hologram' };

  const diff = compareContracts(contract, live);
  assert.equal(diff.identical, false);
  assert.deepEqual(diff.added, ['serverNotifications.thread/brandNew', 'threadItems.hologram']);
  assert.deepEqual(diff.removed, ['clientRequests.turn/steer']);
  assert.deepEqual(diff.changed, ['serverNotifications.account/updated']);
  assert.equal(diff.routing.length, 2);
  assert.match(diff.routing[0], /^serverNotifications\.item\/agentMessage\/delta: routing "threadId" → "global", key "params\.threadId" → null$/);
  assert.match(diff.routing[1], /^serverRequests\.item\/permissions\/requestApproval: key "params\.\w+" → null, threadScoped true → false$/);
});

test('the drift message leads with routing moves, names the fix, and caps each class', () => {
  const diff = {
    identical: false,
    routing: ['serverNotifications.x: routing "threadId" → "global"'],
    removed: ['clientRequests.turn/steer'],
    added: Array.from({ length: 15 }, (_, i) => `serverNotifications.new/${i}`),
    changed: [],
  };
  const message = contractDriftMessage('9.9.9', diff);
  const lines = message.split('\n');
  assert.match(lines[0], /codex-cli 9\.9\.9 no longer matches/);
  assert.ok(lines[0].includes(CODEX_PINNED_VERSION), lines[0]);
  assert.ok(message.indexOf('ROUTING MOVED') < message.indexOf('removed ('), 'routing is reported first');
  assert.ok(message.indexOf('removed (') < message.indexOf('added ('), 'then removals');
  assert.match(message, /misrouting bug/);
  assert.match(message, /… and 3 more/);
  assert.ok(message.includes('serverNotifications.new/11'), 'the 12th item is printed');
  assert.ok(!message.includes('serverNotifications.new/12'), 'the 13th is not');
  assert.ok(message.includes(REGENERATE_COMMAND), message);
  assert.ok(!message.includes('shape changed'), 'an empty class is not printed');
});

test('the match and unverified messages carry the version, the pin, and what to do', () => {
  const match = contractMatchMessage('9.9.9');
  assert.match(match, /codex-cli 9\.9\.9: the live app-server schema matches/);
  assert.ok(match.includes(CODEX_PINNED_VERSION) && match.includes(REGENERATE_COMMAND), match);
  // No version → no generator advice: it would refuse to run.
  const unnamed = contractMatchMessage(null);
  assert.match(unnamed, /an unrecognised codex version: the live app-server schema matches/);
  assert.ok(!unnamed.includes(REGENERATE_COMMAND), unnamed);
  assert.match(unnamed, /cannot be recorded/);
  const unverified = contractUnverifiedMessage(null, 'no schema dump');
  assert.match(unverified, /could not verify .* against an unrecognised codex version: no schema dump/);
  assert.match(unverified, /unverified/);
  assert.ok(unverified.includes(REGENERATE_COMMAND), unverified);
});

// ---------------------------------------------------------------------------
// Drift guard — needs a codex, any codex.
//
// Skipped when codex is absent so CI without it stays green. With one present
// the LIVE SCHEMA is compared to the fixture: a codex whose version differs but
// whose wire contract is identical passes (with a diagnostic saying the pin is
// behind on provenance), and one whose contract moved FAILS with the classified
// diff — because the whole hazard is a schema that moved without anyone looking,
// and a version string cannot tell the two apart.
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
}, (t) => {
  const installedVersion = installed.version;
  // Present-but-unreadable is still a failure: a codex that will not say what
  // it is cannot be reasoned about, and its schema dump is compared below
  // regardless — but the provenance it would record is a lie.
  assert.ok(installedVersion, codexVersionMismatchMessage(null));

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
    const diff = compareContracts(contract, regenerated);
    assert.ok(diff.identical, contractDriftMessage(installedVersion, diff));
    // The broker's handshake opt-out names a capability the distiller does
    // not record (client-request params keep required fields only), so it is
    // pinned here against the live schema: the field must still exist under
    // that exact name, or the opt-out has silently become a no-op.
    const declaresOptOut = readdirSync(schemaDir, { recursive: true })
      .some((f) => String(f).endsWith('.json') && readFileSync(path.join(schemaDir, String(f)), 'utf8').includes('"optOutNotificationMethods"'));
    assert.ok(declaresOptOut, `codex-cli ${installedVersion} no longer declares InitializeCapabilities.optOutNotificationMethods — the broker's handshake opt-out is dead`);
    if (installedVersion !== CODEX_PINNED_VERSION) {
      t.diagnostic(contractMatchMessage(installedVersion));
    }
    // `compareContracts` ignores key order, so the bytes are compared too: same
    // content in a different order still means the next regeneration rewrites
    // the file and buries the real protocol change in a reordering diff. The
    // provenance line is normalised so a version-only skew does not trip this.
    assert.equal(
      readFileSync(CONTRACT_PATH, 'utf8'),
      serializeContract({ ...regenerated, codexVersion: CODEX_PINNED_VERSION }),
      `the committed fixture holds the right content in the wrong byte layout — run: ${REGENERATE_COMMAND}`,
    );
  } finally {
    rmSync(schemaDir, { recursive: true, force: true });
  }
});
