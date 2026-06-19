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

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test('log helpers create stable request ids, write private JSONL rows, and merge req context', () => {
  const id = log.createReqId();
  assert.match(id, /^req_[0-9a-z]+_[0-9a-f]{12}$/);
  // Two ids should be unique.
  assert.notEqual(id, log.createReqId());

  log.logEvent('info', 'unit.test', { req_id: 'req_x', job_id: 'job_y' });
  let lines = readFileSync(log.LOG_FILE, 'utf8').trim().split('\n');
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
  lines = readFileSync(log.LOG_FILE, 'utf8').trim().split('\n');
  last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.req_id, 'req_abc');
  assert.equal(last.job_id, 'job_q');
  assert.equal(last.detail, 1);

  const st = statSync(log.LOG_FILE);
  // mask off file-type bits
  assert.equal(st.mode & 0o777, 0o600);
});
