// Tests for lib/log.mjs (v6.1 E1/E2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX = mkdtempSync(join(tmpdir(), 'copilot-log-'));
process.env.AGENT_COMPANION_HOME = SANDBOX;
process.env.AGENT_COMPANION_LOG_LEVEL = 'trace';

const log = await import('./log.mjs');

assert.equal(log.companionLogFile(), join(SANDBOX, 'daemon.log'));

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test('log helpers create stable request ids, write private JSONL rows, and merge req context', () => {
  const id = log.createReqId();
  assert.match(id, /^req_[0-9a-z]+_[0-9a-f]{12}$/);
  // Two ids should be unique.
  assert.notEqual(id, log.createReqId());

  log.logEvent('info', 'unit.test', { req_id: 'req_x', job_id: 'job_y' });
  let lines = readFileSync(log.companionLogFile(), 'utf8').trim().split('\n');
  let last = JSON.parse(lines[lines.length - 1]);
  assert.deepEqual(
    {
      event: last.event,
      level: last.level,
      req_id: last.req_id,
      job_id: last.job_id,
      pidType: typeof last.pid,
      hasTs: Boolean(last.ts),
    },
    {
      event: 'unit.test',
      level: 'info',
      req_id: 'req_x',
      job_id: 'job_y',
      pidType: 'number',
      hasTs: true,
    },
  );

  const r = log.withReq('req_abc', { job_id: 'job_q' });
  r.info('something.happened', { detail: 1 });
  lines = readFileSync(log.companionLogFile(), 'utf8').trim().split('\n');
  last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.req_id, 'req_abc');
  assert.equal(last.job_id, 'job_q');
  assert.equal(last.detail, 1);

  const st = statSync(log.companionLogFile());
  // mask off file-type bits
  assert.equal(st.mode & 0o777, 0o600);
});

// The redirect has to survive a LATE assignment, not just an early one: a suite
// that statically imports the module under test cannot set AGENT_COMPANION_HOME
// before this module is evaluated, so a path captured at load time would send
// that suite's events to the operator's real daemon.log. Resolution is per call
// for exactly that reason; this is the test that keeps it that way.
test('the daemon log path follows AGENT_COMPANION_HOME set after this module loaded', () => {
  const late = mkdtempSync(join(tmpdir(), 'copilot-log-late-'));
  const prior = process.env.AGENT_COMPANION_HOME;
  process.env.AGENT_COMPANION_HOME = late;
  try {
    assert.equal(log.companionLogFile(), join(late, 'daemon.log'));
    log.logEvent('info', 'late.redirect');
    const lines = readFileSync(join(late, 'daemon.log'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[lines.length - 1]).event, 'late.redirect');
    // And the original sandbox saw nothing new — the write MOVED, it did not fan out.
    assert.ok(!readFileSync(join(SANDBOX, 'daemon.log'), 'utf8').includes('late.redirect'));
  } finally {
    process.env.AGENT_COMPANION_HOME = prior;
    rmSync(late, { recursive: true, force: true });
  }
});
