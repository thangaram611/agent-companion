// Validation is pure except for checking the required cwd.
import '../test/sandbox-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { validateAgentArgs, VALID_ACTIONS, VALID_TARGETS } from './validation.mjs';
import { TARGET_IDS, listTargetIds } from '../lib/target-registry.mjs';

test('validation inventory matches the five registry targets', () => {
  assert.deepEqual([...VALID_TARGETS].sort(), [...TARGET_IDS].sort());
  assert.deepEqual([...VALID_TARGETS].sort(), listTargetIds().sort());
  assert.equal(VALID_TARGETS.size, 5);
});

const TEST_CWD = tmpdir();
const sendArgs = (extra = {}) => ({ action: 'send', task: 'x', cwd: TEST_CWD, ...extra });

test('action schemas reject malformed inputs and normalize valid cancel/wait/status/reply calls', () => {
  assert.deepEqual([...VALID_ACTIONS].sort(), ['cancel', 'catalog', 'reply', 'send', 'status', 'wait']);
  assert.throws(() => validateAgentArgs({}), /action is required/);
  assert.throws(() => validateAgentArgs({ action: 'launch' }), /action must be one of/);

  const cancel = validateAgentArgs({ action: 'cancel', job_id: 'abc-123' });
  assert.deepEqual(cancel, { action: 'cancel', job_id: 'abc-123' });
  assert.throws(() => validateAgentArgs({ action: 'cancel' }), /job_id/);
  assert.throws(() => validateAgentArgs({ action: 'cancel', job_id: 'x', model: 'm' }), /unknown field "model"/);

  const wait = validateAgentArgs({ action: 'wait', job_id: 'j', max_wait_sec: 120 });
  assert.equal(wait.max_wait_sec, 120);
  assert.throws(() => validateAgentArgs({ action: 'wait' }), /job_id/);
  assert.throws(() => validateAgentArgs({ action: 'wait', job_id: 'j', max_wait_sec: 'x' }), /max_wait_sec/);

  const status = validateAgentArgs({ action: 'status', job_id: 'j', verbose: true });
  assert.equal(status.verbose, true);
  assert.equal(status.diagnostics, false);
  assert.equal(status.job_id, 'j');
  assert.equal(validateAgentArgs({ action: 'status', diagnostics: true }).diagnostics, true);
  assert.throws(() => validateAgentArgs({ action: 'status', verbose: 'yes' }), /verbose must be a boolean/);
  assert.throws(() => validateAgentArgs({ action: 'status', diagnostics: 'yes' }), /diagnostics must be a boolean/);

  const reply = validateAgentArgs({ action: 'reply', job_id: 'job-1', message: 'add tests' });
  assert.equal(reply.message, 'add tests');
  assert.throws(() => validateAgentArgs({ action: 'reply', message: 'hi' }), /job_id/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'job-1' }), /message/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'job-1', message: '' }), /message/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'job-1', message: 'x'.repeat(8001) }), /too long/);
  assert.throws(() => validateAgentArgs({ action: 'reply', job_id: 'j', message: 'm', thread: 'x' }), /unknown field/);
});

test('send requires a task and an absolute existing cwd, and validates internal host thread names', () => {
  const basic = validateAgentArgs(sendArgs());
  assert.equal(basic.model, null);
  assert.equal(basic.target, null);
  for (const task of [undefined, '', 42]) assert.throws(() => validateAgentArgs(sendArgs({ task })), /task/);
  assert.throws(() => validateAgentArgs({ action: 'send', task: 'x' }), /cwd is required/);
  assert.throws(() => validateAgentArgs(sendArgs({ cwd: 'relative/path' })), /cwd must be an absolute path/);
  assert.throws(() => validateAgentArgs(sendArgs({ cwd: '/__nope__/__nope__' })), /cwd does not exist/);
  assert.throws(() => validateAgentArgs(sendArgs({ cwd: new URL(import.meta.url).pathname })), /not a directory/);
  assert.equal(validateAgentArgs(sendArgs({ thread: 'my_branch.01-a' })).thread, 'my_branch.01-a');
  assert.throws(() => validateAgentArgs(sendArgs({ thread: '../etc' })), /thread must match/);
  assert.throws(() => validateAgentArgs(sendArgs({ thread: 42 })), /thread must be a string/);
  for (const target of VALID_TARGETS) assert.equal(validateAgentArgs(sendArgs({ target })).target, target);
  assert.equal(validateAgentArgs(sendArgs({ target: 'unknown' })).target, 'unknown', 'controller returns TARGET_UNSUPPORTED');
  assert.throws(() => validateAgentArgs(sendArgs({ target: 42 })), /target must be a string/);
  assert.throws(() => validateAgentArgs(sendArgs({ model: 42 })), /model must be a string/);
  assert.throws(() => validateAgentArgs(sendArgs({ max_wait_sec: 'five' })), /max_wait_sec must be a number/);
});

test('no action takes a session id argument', () => {
  const actions = [
    { action: 'catalog' },
    { action: 'send', task: 'X', cwd: TEST_CWD },
    { action: 'wait', job_id: 'j1' },
    { action: 'status' },
    { action: 'reply', job_id: 'j1', message: 'hi' },
    { action: 'cancel', job_id: 'j1' },
  ];
  for (const args of actions) {
    for (const key of ['host_session_id', 'claude_session_id']) {
      assert.throws(() => validateAgentArgs({ ...args, [key]: 'sid-abc' }), new RegExp(`unknown field "${key}"`), `${args.action} ${key}`);
    }
  }
});

test('execution timeout is not a tool argument; the bounded wait remains supported', () => {
  assert.throws(() => validateAgentArgs(sendArgs({ timeout_ms: 1 })), /unknown field/);
  assert.equal(validateAgentArgs({ action: 'wait', job_id: 'j', max_wait_sec: 1200 }).max_wait_sec, 1200);
  assert.equal(Object.hasOwn(validateAgentArgs(sendArgs()), 'timeout_ms'), false);
});
