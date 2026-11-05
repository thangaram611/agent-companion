import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineReader, codexAppServerSandbox, resolveSteerConfirmMs } from './codex-protocol.mjs';

test('LineReader reassembles frames across chunk boundaries and discards over-cap lines', () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push('{"a":1}\n{"b":').lines, ['{"a":1}']);
  assert.deepEqual(reader.push('2}\n').lines, ['{"b":2}']);
  // Blank lines are not frames.
  assert.deepEqual(reader.push('\n\n').lines, []);

  const capped = new LineReader({ maxLineBytes: 16 });
  assert.deepEqual(capped.push('x'.repeat(40)).lines, []);
  // The tail of the over-cap line is discarded up to the next newline; the
  // frame after it survives, so a single bad peer frame does not desync.
  const after = capped.push(`${'x'.repeat(40)}\n{"ok":1}\n`);
  assert.equal(after.dropped, 1);
  assert.deepEqual(after.lines, ['{"ok":1}']);

  // The case that escapes a cap applied only to the residual buffer: an
  // over-cap line that arrives COMPLETE inside one chunk, newline and all.
  const whole = new LineReader({ maxLineBytes: 16 });
  const single = whole.push(`${'x'.repeat(40)}\n{"ok":1}\n`);
  assert.equal(single.dropped, 1, 'a complete over-cap line must be dropped, not delivered');
  assert.deepEqual(single.lines, ['{"ok":1}']);
});

// --- SubscriptionTable -------------------------------------------------------

test('the sandbox comes from the exec adapter\'s one resolver, with bypass collapsed', () => {
  assert.equal(codexAppServerSandbox({}).mode, 'workspace-write');
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' }).mode, 'read-only');
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'danger-full-access' }).mode, 'danger-full-access');
  // `bypass` is the exec spelling of "no sandbox AND no approvals"; the
  // app-server splits those, and the approvals half is pinned to `never` here.
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' }).mode, 'danger-full-access');
  // An unrecognised value never reaches the wire verbatim and never escalates.
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'yolo' }).mode, 'workspace-write');
});

test('every sandbox mode maps to an EXPLICIT sandboxPolicy, network included', () => {
  // The mode enum is all `thread/start` accepts; the network decision rides
  // `turn/start`'s `sandboxPolicy`, whose every variant defaults `networkAccess`
  // to its RESTRICTIVE value (`false` for the booleans, `'restricted'` for
  // `externalSandbox`'s enum). So silence here is the restrictive direction — the
  // opposite of the exec transport, where omitting the `-c` key defers to
  // config.toml and fails OPEN. Both adapters are explicit, for opposite reasons,
  // and this is the table that keeps them agreeing.
  const policyFor = (env) => codexAppServerSandbox(env).policy;

  // Default and explicit workspace-write: network ON, because a delegated job
  // that cannot `npm install` fails confusingly (codex's own exec default is
  // OFF; the bridge turns it on deliberately).
  assert.deepEqual(policyFor({}), { type: 'workspaceWrite', networkAccess: true });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'workspace-write' }),
    { type: 'workspaceWrite', networkAccess: true });
  // An unrecognised mode behaves like unset — same policy, never an escalation.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'yolo' }),
    { type: 'workspaceWrite', networkAccess: true });

  // The off switch is an EXPLICIT false, not an omitted field. It happens to
  // coincide with the union's default here, which is exactly why it has to be
  // asserted: a future variant whose default flipped would take the bridge's
  // "off" with it.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_NETWORK: 'off' }),
    { type: 'workspaceWrite', networkAccess: false });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_NETWORK: 'OFF' }),
    { type: 'workspaceWrite', networkAccess: false });
  // Only `off` turns it off — no other value is a secret second spelling.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_NETWORK: 'no' }),
    { type: 'workspaceWrite', networkAccess: true });

  // read-only carries the field the variant has, at the value the mode means.
  // The exec resolver reports `network: null` here (its toggle is the
  // workspace-write-scoped config key), so the bridge has no opinion and the
  // network env var must not acquire one.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' }),
    { type: 'readOnly', networkAccess: false });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only', AGENT_COMPANION_CODEX_NETWORK: 'off' }),
    { type: 'readOnly', networkAccess: false });

  // dangerFullAccess has NO networkAccess field — the sandbox is gone, so
  // nothing is restricted. Asserting the exact object is what catches a future
  // edit that "helpfully" adds one.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'danger-full-access' }),
    { type: 'dangerFullAccess' });
  // bypass collapses onto it, exactly as the mode mapping does. Deliberately
  // NOT `externalSandbox`: that variant's network vocabulary is
  // `restricted|enabled` rather than a boolean and its semantics were never
  // measured.
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' }),
    { type: 'dangerFullAccess' });
  assert.deepEqual(policyFor({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass', AGENT_COMPANION_CODEX_NETWORK: 'off' }),
    { type: 'dangerFullAccess' });

  // And the report is true now that the policy is sent. It read `false` for as
  // long as the param name was unmeasured, which was honest then.
  assert.equal(codexAppServerSandbox({}).network_applied, true);
  assert.equal(codexAppServerSandbox({}).network, true);
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_NETWORK: 'off' }).network, false);
  assert.equal(codexAppServerSandbox({ AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' }).network, null);
});

test('the policy tag is one the real server parses — camelCase, never the mode spelling', () => {
  // The one thing the fakes cannot catch. The pinned contract validates top-level
  // field PRESENCE only (deliberately — lib/codex-app-server-contract.mjs records
  // why), so `{type:'workspace-write'}` would sail through every fake in this
  // repo and be refused by codex. And it is an easy slip to make: this union's
  // tags are camelCase while `thread/start`'s `SandboxMode` enum, which the SAME
  // job sends on the SAME transport, is kebab-case.
  //
  // The vocabulary is the server's own words, recited back by 0.147.0 when it
  // refused `{type:'workspace-write'}`:
  //   -32600 "Invalid request: unknown variant `workspace-write`, expected one of
  //           `dangerFullAccess`, `readOnly`, `externalSandbox`, `workspaceWrite`"
  // Measured for zero tokens by aiming each call at the all-zero thread id: the
  // three tags the adapter can emit all got as far as `thread not found`, i.e.
  // the shapes were accepted, while the kebab-case one died at deserialization.
  const PARSED_BY_0_147_0 = new Set(['dangerFullAccess', 'readOnly', 'externalSandbox', 'workspaceWrite']);
  const envs = [
    {},
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'workspace-write' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'read-only' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'danger-full-access' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'bypass' },
    { AGENT_COMPANION_CODEX_SANDBOX_MODE: 'yolo' },
    { AGENT_COMPANION_CODEX_NETWORK: 'off' },
  ];
  for (const env of envs) {
    const { policy, mode } = codexAppServerSandbox(env);
    assert.ok(PARSED_BY_0_147_0.has(policy.type), `${JSON.stringify(env)} → unparseable tag ${policy.type}`);
    // And the two halves of one decision never disagree: the kebab-case mode goes
    // on `thread/start`, the camelCase tag on `turn/start`, both from one resolver.
    assert.equal(policy.type, { 'workspace-write': 'workspaceWrite', 'read-only': 'readOnly', 'danger-full-access': 'dangerFullAccess' }[mode]);
  }
});

test('the steer confirmation window is a bounded, env-overridable number', () => {
  // A probe steering a turn that is sitting inside a 20 s shell command wants to
  // wait past it; `agent_reply` blocks for this, so it is also capped.
  assert.equal(resolveSteerConfirmMs({}), 5_000);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '25000' }), 25_000);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '0' }), 0);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '999999' }), 120_000);
  // Garbage is the default, not a zero window that reports every steer as
  // unconfirmed.
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: 'soon' }), 5_000);
  assert.equal(resolveSteerConfirmMs({ AGENT_COMPANION_CODEX_STEER_CONFIRM_MS: '-1' }), 5_000);
});
