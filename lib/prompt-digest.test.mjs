// prompt-digest.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function withTempDirs(fn) {
  const promptDir = mkdtempSync(join(tmpdir(), 'digest-prompt-'));
  const digestDir = mkdtempSync(join(tmpdir(), 'digest-out-'));
  process.env.AGENT_PROMPT_JSONL_DIR = promptDir;
  process.env.AGENT_DIGEST_DIR = digestDir;
  try { return await fn({ promptDir, digestDir }); }
  finally {
    delete process.env.AGENT_PROMPT_JSONL_DIR;
    delete process.env.AGENT_DIGEST_DIR;
    try { rmSync(promptDir, { recursive: true, force: true }); } catch {}
    try { rmSync(digestDir, { recursive: true, force: true }); } catch {}
  }
}

function writeJsonl(dir, promptId, events) {
  const path = join(dir, `copilot-acp-${promptId}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(path, lines);
  return path;
}

async function freshImport() {
  return import(`./prompt-digest.mjs?ts=${Date.now()}${Math.random()}`);
}

test('renderDigest assembles the full digest contract from a rich prompt transcript', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();
    const promptId = 'p-rich';
    writeJsonl(promptDir, promptId, [
      { type: 'start', sessionId: 's1', promptId, ts: 1 },
      { type: 'message', text: 'Dispatching reviewers. ', ts: 2 },
      { type: 'thought', text: 'internal reasoning -- should be skipped', ts: 3 },
      {
        type: 'tool_call', toolCallId: 's1', name: 'Reviewing csp.ts', kind: 'other',
        locations: null,
        input: { description: 'Review csp.ts', agent_type: 'reviewer', name: 'csp-reviewer', prompt: '...' },
        ts: 4,
      },
      { type: 'message', text: 'SUB-AGENT-NOISE', ts: 5 },
      {
        type: 'tool_call_update', toolCallId: 's1', status: 'completed',
        outputPreview: 'csp.ts: BLOCKING -- frame-ancestors has trailing space.',
        name: 'Reviewing csp.ts', kind: 'other', ts: 6,
      },
      { type: 'message', text: 'All reviewers done. RUBBER-DUCK: clean.', ts: 7 },
      {
        type: 'tool_call', toolCallId: 's2', name: 'Reviewing dev.ts', kind: 'other',
        locations: null,
        input: { description: 'Review dev.ts', agent_type: 'reviewer', name: 'dev-reviewer', prompt: '...' },
        ts: 8,
      },
      { type: 'tool_call', toolCallId: 'a', name: 'view', kind: 'read',
        locations: [{ path: '/repo/csp.ts' }], input: {}, ts: 9 },
      { type: 'tool_call', toolCallId: 'b', name: 'view', kind: 'read',
        locations: [{ path: '/repo/csp.ts' }], input: {}, ts: 10 },
      { type: 'tool_call', toolCallId: 'c', name: 'view', kind: 'read',
        locations: [{ path: '/repo/dev.ts' }], input: {}, ts: 11 },
      { type: 'tool_call', toolCallId: 'd', name: 'edit', kind: 'execute',
        locations: [{ path: '/repo/csp.ts' }], input: {}, ts: 12 },
      { type: 'tool_call', toolCallId: 'e', name: 'view', kind: 'read',
        locations: [{ path: '/repo/src/utils' }], input: {}, ts: 13 },
      { type: 'tool_call', toolCallId: 'f', name: 'view', kind: 'read',
        locations: [{ path: '/repo/node_modules/.pnpm/foo@1.0.0/package.json' }], input: {}, ts: 14 },
      { type: 'tool_call', toolCallId: 'g', name: 'view', kind: 'read',
        locations: [{ path: '/repo/dist/bundle.js' }], input: {}, ts: 15 },
      { type: 'tool_call', toolCallId: 'fail-1', kind: 'read',
        name: "Searching for 'proxyRes|writeHead'", input: {}, ts: 16 },
      { type: 'tool_call_update', toolCallId: 'fail-1', status: 'failed',
        outputPreview: 'rg: /repo/node_modules/foo: No such file or directory (os error 2)', ts: 17 },
      { type: 'tool_call_update', toolCallId: 'd', status: 'completed',
        outputPreview: 'edit applied', name: 'edit', ts: 18 },
      { type: 'plan', entries: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
      ], ts: 19 },
      { type: 'plan', entries: [
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'completed' },
      ], ts: 20 },
    ]);

    const md = buildDigest(promptId, {
      jobId: 'job-rich', status: 'timeout', mode: 'EXECUTE',
      template: 'general', thread: 'companion-job-1',
      startedAt: Date.now() - 5000, terminalAt: Date.now(),
      task: 'say hi',
    });

    assert.match(md, /# Copilot job job-rich — digest/);
    assert.match(md, /\*\*Status:\*\* `timeout`/);
    assert.match(md, /\*\*Template:\*\* general/);
    assert.match(md, /## Task[\s\S]*say hi/);
    assert.match(md, /## Final \/ partial assistant message/);
    assert.match(md, /Dispatching reviewers/);
    assert.doesNotMatch(md, /internal reasoning/);
    assert.doesNotMatch(md, /SUB-AGENT-NOISE/);
    assert.match(md, /interleaved \/fleet sub-agent streams omitted/);

    assert.match(md, /## Sub-agent reports \(\/fleet\)/);
    assert.match(md, /### `csp-reviewer` — completed/);
    assert.match(md, /\*Review csp\.ts\*/);
    assert.match(md, /frame-ancestors has trailing space/);
    assert.match(md, /### `dev-reviewer` — running/);
    assert.match(md, /\(no report yet — still running\)/);

    assert.match(md, /## Source files touched/);
    assert.match(md, /`\/repo\/csp\.ts` \(3x\)/);
    assert.match(md, /`\/repo\/dev\.ts`(?! \()/);
    assert.match(md, /## Other paths explored/);
    assert.match(md, /`\/repo\/src\/utils`/);
    assert.match(md, /`\/repo\/node_modules\/\.pnpm\/foo@1\.0\.0\/package\.json`/);
    assert.match(md, /`\/repo\/dist\/bundle\.js`/);

    assert.match(md, /## Failed tool calls/);
    assert.match(md, /`read` — \*\*Searching for 'proxyRes\|writeHead'\*\*/);
    assert.match(md, /> rg: \/repo\/node_modules\/foo: No such file/);

    assert.match(md, /## Tool-call summary/);
    assert.match(md, /`read`: 7 \(1 failed\)/);
    assert.match(md, /`execute`: 1/);
    assert.match(md, /`other`: 2/);
    assert.match(md, /sub-agent invocations: 2/);

    assert.match(md, /## Todos \(latest snapshot\)/);
    assert.match(md, /- \[x\] A \*\(completed\)\*/);
    assert.match(md, /- \[x\] B \*\(completed\)\*/);
    assert.doesNotMatch(md, /- \[~\] A/);
  });
});

test('renderDigest handles timeout fleet elision, truncation, and empty-section omission', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest } = await freshImport();

    writeJsonl(promptDir, 'p-timeout-fleet', [
      { type: 'message', text: 'Starting parallel reviews.', ts: 100 },
      { type: 'tool_call', toolCallId: 's1', name: 'r', kind: 'other',
        input: { agent_type: 'reviewer', name: 'r1' }, ts: 200 },
      { type: 'message', text: 'INTERLEAVED-CRUFT', ts: 300 },
    ]);
    const timeout = buildDigest('p-timeout-fleet', { jobId: 'job-to', status: 'timeout' });
    assert.match(timeout, /Starting parallel reviews/);
    assert.doesNotMatch(timeout, /INTERLEAVED-CRUFT/);
    assert.match(timeout, /interleaved \/fleet sub-agent streams omitted/);

    writeJsonl(promptDir, 'p-big', [
      { type: 'message', text: 'x'.repeat(20_000), ts: 1 },
    ]);
    const truncated = buildDigest('p-big', { jobId: 'job-8' });
    assert.match(truncated, /\[truncated\]/);
    assert.ok(truncated.length < 20_000, 'digest is bounded');

    writeJsonl(promptDir, 'p-empty', [
      { type: 'start', promptId: 'p-empty', ts: 1 },
    ]);
    const empty = buildDigest('p-empty', { jobId: 'job-9' });
    for (const section of [
      /## Final \/ partial assistant message/,
      /## Sub-agent reports/,
      /## Failed tool calls/,
      /## Source files touched/,
      /## Other paths explored/,
      /## Tool-call summary/,
      /## Todos/,
    ]) {
      assert.doesNotMatch(empty, section);
    }
    assert.match(empty, /# Copilot job job-9 — digest/);
  });
});

test('buildDigest/writeDigest handle missing transcripts, orphan jobs, and private digest files', async () => {
  await withTempDirs(async ({ promptDir }) => {
    const { buildDigest, writeDigest, digestPath } = await freshImport();
    assert.equal(buildDigest('p-missing', { jobId: 'job-6' }), null);
    assert.equal(buildDigest(null, { jobId: 'job-6' }), null);

    writeJsonl(promptDir, 'p-write', [
      { type: 'message', text: 'done', ts: 1 },
    ]);
    const path = writeDigest('p-write', { jobId: 'job-7', status: 'completed' });
    assert.ok(path, 'returns path');
    assert.equal(path, digestPath('job-7'));
    assert.ok(existsSync(path), 'file exists');
    const content = readFileSync(path, 'utf8');
    assert.match(content, /Copilot job job-7/);
    assert.match(content, /done/);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    writeJsonl(promptDir, 'p-no-jobid', [
      { type: 'message', text: 'orphan', ts: 1 },
    ]);
    assert.equal(writeDigest('p-no-jobid', {}), null);
  });
});
