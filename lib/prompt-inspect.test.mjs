import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildPromptInspection } from './prompt-inspect.mjs';

describe('buildPromptInspection', () => {
  it('filePath skips a whitespace-only path field and uses the next valid one', () => {
    const inspection = buildPromptInspection(
      { promptId: 'p', sessionId: 's', cwd: '/repo', status: 'running', startedAt: 0, lastEventAt: 1_000, msSinceLastEvent: 0 },
      [{ type: 'tool_call', toolCallId: 'tw', name: 'view', kind: 'read', input: { path: '   ', file_path: '/real/file.js', view_range: [1, 5] }, ts: 1_000 }],
      { includeTimeline: true, limit: 10 },
    );
    assert.match(inspection.activity[0], /read file \/real\/file\.js/);
  });

  it('summarizes activity and applies tail limits', () => {
    const events = [
      {
        type: 'tool_call',
        toolCallId: 't1',
        name: 'view',
        kind: 'read',
        input: { path: '/repo/src/index.ts', view_range: [1, 120] },
        ts: 1_000,
      },
      {
        type: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        outputPreview: 'export const value = 1;',
        name: 'view',
        ts: 2_000,
      },
      {
        type: 'tool_call',
        toolCallId: 't2',
        name: 'github-mcp-server-search_code',
        kind: 'search',
        input: { query: 'repo:cline/cline Tree-sitter OR tree-sitter path:src' },
        ts: 3_000,
      },
      {
        type: 'tool_call_update',
        toolCallId: 't2',
        status: 'failed',
        outputPreview: 'failed to search code with query',
        name: 'github-mcp-server-search_code',
        ts: 4_000,
      },
      {
        type: 'plan',
        entries: [
          { status: 'in_progress', title: 'Inspect parser files' },
          { status: 'pending', title: 'Check callsites' },
        ],
        ts: 5_000,
      },
      { type: 'message', text: 'Found repeated failures. ', ts: 6_000 },
      { type: 'message', text: 'Need caller-side recovery.', ts: 7_000 },
      { type: 'stuck', reason: 'failures:3_failed_tool_calls:github-mcp-server-search_code', ts: 8_000 },
    ];

    const inspection = buildPromptInspection(
      {
        promptId: 'prompt-1',
        sessionId: 'session-1',
        cwd: '/repo',
        status: 'stuck',
        startedAt: 0,
        terminalAt: 8_000,
        lastEventAt: 8_000,
        msSinceLastEvent: 0,
        retentionExpiresAt: 10_000,
        stuckReason: 'failures:3_failed_tool_calls:github-mcp-server-search_code',
        stuckDetail: 'err="failed to search code with query"',
      },
      events,
      { includeTimeline: true, limit: 10 },
    );

    assert.equal(inspection.status, 'stuck');
    assert.equal(inspection.cwd, '/repo');
    assert.equal(inspection.failedTools[0], 'github-mcp-server-search_code');
    assert.match(inspection.latestPlan, /Inspect parser files/);
    assert.match(inspection.activity[0], /^\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] read file \/repo\/src\/index\.ts/);
    assert.match(inspection.activity[1], /web_search .*-> failed:/);
    assert.match(inspection.activity[2], /plan update:/);
    assert.match(inspection.activity[3], /copilot output: "Found repeated failures\. Need caller-side recovery\."/);
    assert.match(inspection.activity[4], /supervisor marked prompt stuck:/);

    const limitEvents = [];
    for (let i = 0; i < 5; i++) {
      limitEvents.push({ type: 'message', text: `chunk ${i}`, ts: i + 1 });
      limitEvents.push({ type: 'plan', entries: [{ title: `step ${i}` }], ts: i + 100 });
    }

    const limited = buildPromptInspection(
      {
        promptId: 'prompt-2',
        sessionId: 'session-2',
        cwd: '/repo',
        status: 'completed',
        startedAt: 0,
        terminalAt: 500,
        lastEventAt: 500,
        msSinceLastEvent: 0,
        retentionExpiresAt: 1_000,
      },
      limitEvents,
      { includeTimeline: true, limit: 3 },
    );

    assert.equal(limited.activity.length, 3);
    assert.equal(limited.activityTruncated, true);
    assert.match(limited.activity[0], /step 3|chunk 4/);
    assert.match(limited.activity[2], /step 4/);
  });
});
