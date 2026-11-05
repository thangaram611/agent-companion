import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows, readJSON, writeJSON, pidRecords, phaseAt, inside } from './common.mjs';

function isolationReport(dir, events, hooks, stream) {
  // Claude Code's built-in agents are always in the inventory; they are not a leak
  // from the operator's configuration. User-level agents (for example the
  // production agent-companion) are, and stay flagged.
  const BUILTIN_AGENTS = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup', 'claude-code-guide'];
  const agents = new Set([...Object.keys(readJSON(dir + '/agents.json', {})), ...BUILTIN_AGENTS]);
  const ourEvents = new Set(Object.keys(readJSON(dir + '/settings.json', {}).hooks ?? {}));
  const servers = new Set(Object.keys(readJSON(dir + '/mcp.json', {}).mcpServers ?? {}));
  const commands = new Set(Object.values(readJSON(dir + '/settings.json', {}).hooks ?? {})
    .flatMap(rules => rules.flatMap(rule => rule.hooks ?? [])).map(h => h.command).filter(Boolean));
  const defects = [];
  const add = (kind, name, source, reason) => {
    if (typeof name === 'string' && name && !defects.some(d => d.kind === kind && d.name === name))
      defects.push({ kind, name, source, reason });
  };
  const check = (kind, name, allowed, source) => {
    if (!allowed.has(name)) add(kind, name, source, 'Not declared by this run');
  };
  const tool = (name, input, source) => {
    const server = name?.match(/^mcp__(.+?)__/);
    if (server) check('mcp-server', server[1], servers, source);
    if (name === 'Agent') check('agent', input?.subagent_type, agents, source);
  };
  for (const h of hooks) {
    const p = h.payload ?? {};
    check('agent', p.agent_type, agents, h.source);
    check('mcp-server', typeof p.mcp_server === 'string' ? p.mcp_server : p.mcp_server?.name, servers, h.source);
    tool(p.tool_name, p.tool_input, h.source);
  }
  for (const e of events.filter(e => e.event === 'server_start')) check('mcp-server', e.channel, servers, e.source);
  const init = stream.filter(s => s.type === 'system' && s.subtype === 'init');
  for (const s of init) {
    for (const a of Array.isArray(s.agents) ? s.agents : []) check('agent', typeof a === 'string' ? a : a.name, agents, s.source);
    for (const m of Array.isArray(s.mcp_servers) ? s.mcp_servers : []) check('mcp-server', typeof m === 'string' ? m : m.name, servers, s.source);
    for (const name of Array.isArray(s.tools) ? s.tools : []) tool(name, null, s.source);
  }
  for (const s of stream) {
    for (const block of Array.isArray(s.message?.content) ? s.message.content : [])
      if (block.type === 'tool_use') tool(block.name, block.input, s.source);
  }
  const hookFrames = stream.filter(s => s.type === 'system' && s.subtype?.startsWith('hook_'));
  const commandOf = h => h.command ?? h.hook_command ?? h.hook?.command;
  const ownIds = new Set(hookFrames.filter(h => commands.has(commandOf(h)) || commands.has(h.hook_name))
    .map(h => h.hook_id).filter(Boolean));
  for (const h of hookFrames) {
    const command = commandOf(h);
    // Hook frames name the event and matcher (`PreToolUse:Agent`) without the
    // command. With --setting-sources "" every configured hook is ours, so a frame
    // for an event this run configured is attributable; an unconfigured event is not.
    const ours = command ? commands.has(command)
      : commands.has(h.hook_name) || ownIds.has(h.hook_id) || ourEvents.has(String(h.hook_name ?? '').split(':')[0]);
    if (!ours) add('hook', h.hook_name ?? h.hook_id ?? 'unnamed host hook', h.source,
      command ? 'Command is not one of this run\'s hooks' : 'Host hook has no attributable fixture command');
  }
  const coverage = { agentInventory: init.some(s => Array.isArray(s.agents)),
    mcpInventory: init.some(s => Array.isArray(s.mcp_servers)), hookFrames: hookFrames.length,
    malformedStream: stream.some(s => s.event === 'parse_error') };
  return { status: defects.length ? 'defect' : coverage.agentInventory && coverage.mcpInventory &&
    coverage.hookFrames && !coverage.malformedStream ? 'no-defects-observed' : 'unverified', defects, coverage,
    note: 'Uses run-local records only. Advertised foreign agents count even if unused; unattributed host hooks are defects. Missing inventories are not proof of isolation.' };
}

export function analyze(dir) {
  dir = path.resolve(dir);
  const config = readJSON(dir + '/scenario.json', {});
  const command = readJSON(dir + '/command.json', {});
  const authMode = command.authMode ?? (command.envOverrides?.CLAUDE_CONFIG_DIR ? 'isolated-config' : 'unknown');
  const events = rows(dir, 'events.jsonl');
  const hooks = rows(dir, 'hooks.jsonl');
  const control = rows(dir, 'controller.jsonl');
  const samples = rows(dir, 'samples.jsonl');
  const beats = rows(dir, 'heartbeats.jsonl');
  const ledger = pidRecords(dir);
  const cleanupAt = control.find(x => x.event === 'cleanup_start')?.t ?? Infinity;
  const endSample = samples.filter(x => x.t <= cleanupAt).at(-1);
  const end = endSample?.t ?? Math.max(0, ...events.map(x => x.t ?? 0), ...hooks.map(x => x.t ?? 0));
  const starts = events.filter(x => x.event === 'tool_start');
  const pre = hooks.filter(x => x.payload?.hook_event_name === 'PreToolUse');
  const post = hooks.filter(x => ['PostToolUse', 'PostToolUseFailure'].includes(x.payload?.hook_event_name));
  const originalOwners = new Set(hooks.filter(x => x.payload?.hook_event_name === 'SubagentStart').map(x => x.payload.agent_id));
  const calls = starts.map(call => {
    const toolUseId = call.meta?.['claudecode/toolUseId'];
    const matches = toolUseId ? pre.filter(h => h.payload.tool_use_id === toolUseId) : [];
    const hook = matches.length === 1 ? matches[0] : null;
    const owner = hook?.payload.agent_id ?? null;
    const returned = events.find(x => ['tool_return', 'tool_error'].includes(x.event) && x.pid === call.pid && x.requestId === call.requestId);
    return { source: call.source, t: call.t, serverPid: call.pid, channel: call.channel, tool: call.name,
      requestId: call.requestId, toolUseId: toolUseId ?? null, meta: call.meta,
      inBandOwner: call.args.thread ?? null, hookOwner: owner, agentType: hook?.payload.agent_type ?? null,
      hookSource: hook?.source ?? null, hookMatches: matches.length,
      identity: !hook ? 'unverified' : owner ? (call.args.thread === owner ? 'native-owner-matches' : 'MISMATCH')
        : (call.args.thread ? 'FABRICATED-OWNER-NOT-CLEARED' : 'ownerless'),
      cwd: { supplied: call.args.cwd ?? null, childReported: call.args.childCwd ?? null,
        parentReported: call.args.parentCwd ?? null, hook: hook?.payload.cwd ?? null, server: call.serverCwd },
      marker: call.args.marker ?? null, returnedAt: returned?.t ?? null,
      result: returned?.result ?? null, error: returned?.error ?? null };
  });
  const executions = events.filter(x => x.event === 'dispatch');
  const anchors = [];
  for (const h of hooks) {
    const p = h.payload;
    if (!p) continue;
    if (p.hook_event_name === 'PreToolUse' && p.tool_name === 'TaskStop') {
      const taskId = p.tool_input?.task_id;
      // Exact native ID equality, confirmed by SubagentStart AND Agent's native response.
      const launched = post.find(x => x.payload.tool_name === 'Agent' && x.payload.tool_response?.agentId === taskId);
      anchors.push({ t: h.t, name: 'TaskStop', owner: originalOwners.has(taskId) ? taskId : null,
        taskId, taskMapping: launched && originalOwners.has(taskId) ? 'native-Agent-response-and-SubagentStart' : 'unverified',
        source: h.source, toolUseId: p.tool_use_id });
    } else if (['SubagentStop', 'SessionEnd', 'PreCompact'].includes(p.hook_event_name) ||
        (p.hook_event_name === 'Stop' && !p.agent_id)) {
      anchors.push({ t: h.t, name: p.hook_event_name, owner: p.agent_id ?? null, source: h.source, trigger: p.trigger ?? null });
    }
  }
  for (const c of control.filter(x => ['host_event', 'operator_event', 'host_exit'].includes(x.event))) {
    anchors.push({ t: c.t, name: c.name ?? c.event, owner: c.owner ?? null, source: c.source,
      actionOnly: c.event === 'operator_event', target: c.target ?? null });
  }
  anchors.sort((a, b) => a.t - b.t);
  const signals = events.filter(x => x.t < cleanupAt && ['cancelled', 'stdin_eof', 'server_signal'].includes(x.event)).map(x => {
    const call = x.event === 'cancelled' ? starts.find(c => c.pid === x.pid && c.requestId === x.params?.requestId) : null;
    return { t: x.t, source: x.source, serverPid: x.pid, channel: x.channel,
      signal: x.event === 'cancelled' ? 'cancelled' : x.event === 'stdin_eof' ? 'EOF' : x.signal,
      requestId: x.params?.requestId ?? null, owner: call?.args.thread ?? null };
  });
  function survival(at, atEnd = false) {
    const sample = atEnd ? endSample : samples.find(x => x.t >= at && x.t <= at + 2000 && x.t < cleanupAt);
    return ledger.filter(p => ['worker', 'leaf', 'grandchild'].includes(p.role)).map(p => {
      const measured = sample?.processes?.find(x => x.pid === p.target);
      const heartbeat = beats.find(b => b.pid === p.target && b.t >= at && b.t <= at + 1250 && b.t < cleanupAt);
      const state = measured && measured.state !== 'unknown' ? measured.state
        : heartbeat ? 'alive-heartbeat' : p.t > at ? 'not-yet-recorded' : 'unknown';
      return { pid: p.target, role: p.role, executionId: p.executionId, channel: p.channel, state,
        alive: ['alive', 'alive-heartbeat'].includes(state) ? true : ['absent', 'zombie'].includes(state) ? false : null,
        sampleAt: sample?.t ?? heartbeat?.t ?? null, offsetMs: sample ? sample.t - at : heartbeat ? heartbeat.t - at : null,
        evidence: sample?.source ?? heartbeat?.source ?? null };
    });
  }
  const eventRows = anchors.map((anchor, index) => {
    const windowEnd = Math.min(end, cleanupAt, anchors[index + 1]?.t ?? Infinity);
    const globalEvent = ['SessionEnd', 'Stop', 'host_exit', 'parent-sigkill', 'parent-exit', 'wall-timeout', 'runner-interrupted'].includes(anchor.name);
    const attributable = signals.filter(s => {
      if (s.t < anchor.t || s.t > end) return false;
      if (anchor.name === 'TaskStop' && s.signal === 'cancelled' && anchor.owner) {
        const pending = calls.find(c => c.serverPid === s.serverPid && c.requestId === s.requestId && c.t <= anchor.t);
        return s.owner === anchor.owner && !!pending;
      }
      return s.t <= windowEnd && (globalEvent || !anchor.owner || (s.owner ? s.owner === anchor.owner : s.channel === 'fixture'));
    });
    const nativeStart = hooks.find(x => x.payload?.hook_event_name === 'SubagentStart' && x.payload.agent_id === anchor.owner);
    const phase = phaseAt(events, hooks, anchor.t, anchor.owner);
    return { ...anchor, actualPhase: phase.phase, intendedPhase: config.phase ?? null,
      landedInIntendedPhase: config.phase ? phase.phase === config.phase : null,
      msAfterChildStart: nativeStart ? anchor.t - nativeStart.t : null,
      received: attributable.length ? attributable.map(s => ({ ...s, delayMs: s.t - anchor.t })) : [{ signal: 'none',
        observedForMs: Math.max(0, windowEnd - anchor.t), qualification: 'No signal in this event window; not proof of owner death or survival' }],
      survivalPlus5s: survival(anchor.t + 5000), survivalAtEnd: survival(end, true),
      stopResult: anchor.toolUseId ? post.find(x => x.payload.tool_use_id === anchor.toolUseId)?.payload ?? null : null };
  });
  const gaps = [];
  for (const dispatch of executions) {
    const owned = calls.filter(c => c.channel === dispatch.channel && c.inBandOwner === dispatch.owner);
    const waits = owned.filter(c => c.tool === 'wait');
    const send = owned.find(c => c.tool === 'send' && c.result?.executionId === dispatch.executionId);
    const boundaries = [{ kind: 'dispatch-to-first-wait', from: send?.returnedAt ?? dispatch.t, next: waits[0] },
      ...waits.filter(w => w.returnedAt !== null && w.result?.status === 'running')
        .map(w => ({ kind: 'between-waits', from: w.returnedAt, next: waits.find(n => n.t > w.returnedAt) }))];
    for (const gap of boundaries) {
      const until = gap.next?.t ?? end;
      gaps.push({ owner: dispatch.owner, executionId: dispatch.executionId, channel: dispatch.channel, kind: gap.kind,
        from: gap.from, until, durationMs: until - gap.from, openAtEnd: !gap.next,
        catalogCalls: owned.filter(c => c.tool === 'catalog' && c.t >= gap.from && c.t <= until).map(c => c.source),
        hookGate: hooks.some(h => h.event === 'gate_start' && h.owner === dispatch.owner && h.t >= gap.from && h.t <= until) });
    }
  }
  const messages = pre.filter(x => x.payload.tool_name === 'SendMessage').map(h => {
    const input = h.payload.tool_input ?? {};
    const response = post.find(x => x.payload.tool_use_id === h.payload.tool_use_id);
    const target = input.to ?? input.recipient ?? null;
    const marker = ['resume-confirmed', 'followup-delivered', 'steering-delivered'].find(m => JSON.stringify(input).includes(m));
    const delivered = marker && calls.find(c => c.t >= h.t && c.marker === marker && c.identity === 'native-owner-matches' &&
      (c.hookOwner === target || c.hookOwner === response?.payload.tool_response?.resumedAgentId));
    const waiting = calls.find(c => c.tool === 'wait' && c.hookOwner === (delivered?.hookOwner ?? target) &&
      c.t <= h.t && (c.returnedAt === null || c.returnedAt >= h.t));
    const cancelled = waiting && signals.find(s => s.signal === 'cancelled' && s.serverPid === waiting.serverPid &&
      s.requestId === waiting.requestId && s.t >= h.t);
    return { source: h.source, t: h.t, target, input, nativeResponse: response?.payload ?? null, marker: marker ?? null,
      outcome: delivered ? 'same-native-owner-call-observed' : response?.payload.hook_event_name === 'PostToolUseFailure'
        ? 'native-tool-failed' : 'delivery-unverified', deliveryEvidence: delivered?.source ?? null,
      deliveryDelayMs: delivered ? delivered.t - h.t : null,
      waitPendingAtSend: !!waiting, cancelledDelayMs: cancelled ? cancelled.t - h.t : null,
      actedWhileFixtureWaitPending: delivered && waiting ? waiting.returnedAt === null || delivered.t < waiting.returnedAt : null,
      note: 'An acknowledgement or action after wait return alone does not prove transcript delivery time or queueing.' };
  });
  const paths = new Set(hooks.flatMap(h => [h.payload?.transcript_path, h.payload?.agent_transcript_path]).filter(Boolean));
  const transcripts = [...paths].map(file => {
    const contained = inside(dir, path.resolve(file)) && (!fs.existsSync(file) || inside(dir, fs.realpathSync(file)));
    return { path: contained ? path.relative(dir, file) : file, available: contained ? fs.existsSync(file) : null,
      inspected: contained, note: contained ? 'Run-local transcript; availability only, resume not inferred' : 'Outside run; not read' };
  });
  const saved = executions.map(x => ({ executionId: x.executionId, owner: x.owner, historyId: x.historyId,
    header: readJSON(dir + '/executions/' + x.executionId + '.json'),
    partial: readJSON(dir + '/executions/' + x.executionId + '.partial.json'),
    result: readJSON(dir + '/executions/' + x.executionId + '.result.json'), fake: true }));
  const issues = [...events, ...hooks, ...control, ...samples, ...beats].filter(x => x.event === 'parse_error');
  const version = fs.existsSync(dir + '/host-version.txt') ? fs.readFileSync(dir + '/host-version.txt', 'utf8').trim() : null;
  const stream = rows(dir, 'stdout.jsonl');
  const isolation = isolationReport(dir, events, hooks, stream);
  return { schema: 1, scenario: config.name, mode: config.mode, authMode, persistenceRequested: command.persistence ?? null,
    measure: config.measure, isolation,
    qualification: isolation.defects.length ? 'Isolation defect: do not qualify this run' :
      'Operator review required; passive measurement is not a cleanup implementation',
    hostVersion: version, config, measurementEnd: end, cleanupStartsAt: Number.isFinite(cleanupAt) ? cleanupAt : null,
    modelsObserved: [...new Set([...post.map(h => h.payload.tool_response?.resolvedModel),
      ...stream.filter(s => s.type === 'system').map(s => s.model)].filter(Boolean))],
    nativeOwnerPerCall: calls, hostEvents: eventRows, allReceivedSignals: signals, attachmentGaps: gaps,
    hookEventsSeen: Object.fromEntries([...new Set(hooks.map(h => h.payload?.hook_event_name).filter(Boolean))]
      .map(name => [name, hooks.filter(h => h.payload?.hook_event_name === name).length])),
    serverInstances: events.filter(e => e.event === 'server_start'),
    connectionFailures: post.filter(h => h.payload.hook_event_name === 'PostToolUseFailure'),
    sameChildResume: messages.filter(m => m.marker === 'resume-confirmed'),
    followupAndSteering: messages.filter(m => m.marker !== 'resume-confirmed'),
    savedState: { fakeProvider: saved, nativeTranscripts: transcripts },
    survivalAtMeasurementEnd: survival(end, true), cleanup: readJSON(dir + '/cleanup.json'),
    hostExit: readJSON(dir + '/exit.json'), costAndUsage: stream.filter(x => x.type === 'result')
      .map(x => ({ total_cost_usd: x.total_cost_usd ?? null, usage: x.usage ?? null, subtype: x.subtype })),
    progressFrames: events.filter(e => e.event === 'frame' && e.direction === 'out' && e.frame?.method === 'notifications/progress').length,
    parseIssues: issues,
    limits: ['SIGKILL cannot be caught: controller send and observed PID state are separate evidence.',
      'Hook-induced gaps are not measurements of healthy model/compaction delay and cannot choose a production lease.',
      'A missing heartbeat, hook, signal or resume marker is unknown, not proof of termination or delivery.',
      'Post-cleanup death is excluded from host survival measurements.',
      'Wall-clock jump/suspend rows require manual timeline review; monotonic timestamps are recorded per process.',
      'Native provider cold resume, production cleanup and native MCP task mode are not implemented here.'] };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(process.argv[2]);
  const result = analyze(dir);
  writeJSON(dir + '/analysis.json', result);
  console.log(JSON.stringify({ analysis: dir + '/analysis.json', calls: result.nativeOwnerPerCall.length,
    hostEvents: result.hostEvents.length, cleanup: result.cleanup?.allGone ?? 'unverified' }));
}
