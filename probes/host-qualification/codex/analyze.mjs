import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, rows, writeJSON } from './common.mjs';

const input = h => {
  if (typeof h?.tool_input !== 'string') return h?.tool_input ?? {};
  try { return JSON.parse(h.tool_input); } catch { return {}; }
};
function filesBelow(dir, root = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (e.isSymbolicLink()) return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesBelow(p, root) : [{ path: path.relative(root, p), bytes: fs.statSync(p).size }];
  });
}
export function analyze(dir) {
  const manifest = readJSON(path.join(dir, 'manifest.json'), {});
  const c = readJSON(path.join(dir, 'scenario.json'), {});
  const rpc = rows(dir, 'mcp.jsonl');
  const hooks = rows(dir, 'hooks.jsonl');
  const supervisor = rows(dir, 'supervisor.jsonl');
  const samples = rows(dir, 'samples.jsonl');
  const cutoff = supervisor.find(r => r.type === 'external_cleanup_started')?.time ?? Infinity;
  const end = supervisor.find(r => r.type === 'observation_end');
  const calls = rpc.filter(r => r.type === 'rpc' && r.direction === 'in' && r.message.method === 'tools/call').map(r => ({
    time: r.time, mono_ms: r.mono_ms, server_pid: r.server_pid, request_id: r.message.id,
    tool: r.message.params.name, arguments: r.message.params.arguments,
    owner: r.message.params._meta?.['x-codex-turn-metadata'] ?? null, full_meta: r.message.params._meta ?? null,
  }));
  const dispatches = rows(dir, 'history.jsonl').filter(r => r.type === 'dispatch');
  const owned = dispatches.filter(e => e.label === 'owned');
  const phases = rpc.filter(r => r.type === 'phase');
  function phaseAt(time, id) {
    const gate = hooks.filter(g => g.type === 'gate_start' && g.time <= time && (!g.execution_id || g.execution_id === id) &&
      time < g.time + c.gate_sec * 1000 && !hooks.some(e => e.type === 'gate_end' && e.gate_id === g.gate_id && e.time <= time)).at(-1);
    return gate ? { phase: gate.phase, since: gate.time, source: 'fixture_pre_tool_gate', execution_id: gate.execution_id } :
      phases.filter(p => p.execution_id === id && p.time <= time).at(-1) ?? { phase: 'not_observed' };
  }
  const signalRows = rpc.filter(r => r.time < cutoff && ['request_cancelled', 'stdin_eof', 'server_signal'].includes(r.type)).map(r => {
    const call = calls.find(v => v.server_pid === r.server_pid && v.request_id === r.request_id);
    return { time: r.time, mono_ms: r.mono_ms, server_pid: r.server_pid,
      signal: r.type === 'request_cancelled' ? 'cancelled' : r.type === 'stdin_eof' ? 'EOF' : r.signal,
      request_id: r.request_id ?? null, reason: r.reason ?? null, owner: call?.owner ?? null,
      execution_id: call?.arguments?.execution_id ?? null };
  });
  const events = supervisor.filter(r => r.time < cutoff && ['host_event', 'host_exit', 'operator_action'].includes(r.type)).map(r => ({ ...r, source: 'supervisor' }));
  for (const h of hooks.filter(h => h.type === 'hook' && h.time < cutoff)) {
    const p = h.payload;
    if (p.hook_event_name === 'PreToolUse' && /interrupt_agent|close_agent|followup_task|send_message/.test(p.tool_name ?? '')) {
      const post = hooks.find(x => x.type === 'hook' && x.time >= h.time && x.payload?.hook_event_name === 'PostToolUse' &&
        x.payload.tool_name === p.tool_name && (p.tool_use_id ? x.payload.tool_use_id === p.tool_use_id : true));
      events.push({ time: h.time, mono_ms: h.mono_ms, action: p.tool_name, source: 'native_tool_pre_hook',
        arguments: input(p), after_time: post?.time ?? null, tool_call_id: p.tool_use_id ?? p.tool_call_id ?? null });
    } else if (['SubagentStop', 'SessionEnd', 'Interrupt', 'PreCompact', 'PostCompact', 'SessionStart', 'SubagentStart'].includes(p.hook_event_name)) {
      events.push({ time: h.time, mono_ms: h.mono_ms, action: p.hook_event_name, source: 'native_hook', payload: p });
    }
  }
  for (const call of calls.filter(c => /^(before:|after:|unavailable:)/.test(c.arguments?.label ?? ''))) {
    events.push({ time: call.time, mono_ms: call.mono_ms, action: call.arguments.label, source: 'model_marker_only' });
  }
  for (const p of rows(dir, 'pty-events.jsonl').filter(r => r.type === 'pty_input_delivered' && r.time < cutoff)) events.push({ ...p, source: 'pty_submission_only' });
  const processView = sample => sample?.processes?.map(p => ({ ...p,
    heartbeat_age_ms: p.heartbeat ? sample.time - p.heartbeat.time : null,
    // kill(pid,0) is not an exit check: a zombie still exists. Fresh heartbeats strengthen survival only.
    advancing_recently: !!p.heartbeat && sample.time - p.heartbeat.time >= 0 && sample.time - p.heartbeat.time <= 1600,
  })) ?? null;
  const eventRows = events.sort((a, b) => a.time - b.time).map(event => {
    const at5 = samples.find(s => s.time >= event.time + 5000 && s.time <= event.time + 6500 && s.time < cutoff);
    const relevantIds = event.execution_id ? [event.execution_id] : owned.map(o => o.execution_id);
    // Explicitly a time window, not an assertion of causal attribution. Raw signals remain above.
    const within = signalRows.filter(s => s.time >= event.time && s.time <= Math.min(event.time + 6500, cutoff));
    const spawns = hooks.filter(h => h.type === 'hook' && h.payload?.hook_event_name === 'SubagentStart' && h.time <= event.time);
    const ownerThread = owned.length === 1 ? owned[0].owner?.thread_id : null;
    const spawn = spawns.find(h => ownerThread && h.payload.agent_id === ownerThread) ?? (spawns.length === 1 ? spawns[0] : null);
    return { ...event, phase_at_event: relevantIds.length ? relevantIds.map(id => ({ execution_id: id, ...phaseAt(event.time, id) })) : [phaseAt(event.time, null)],
      after_spawn_ms: spawn ? event.time - spawn.time : null,
      spawn_anchor: spawn ? { time: spawn.time, agent_id: spawn.payload.agent_id ?? null,
        basis: spawn.payload.agent_id === ownerThread ? 'matching_agent_id' : 'single_observed_SubagentStart' } : null,
      signal_window_ms: 6500, signals: within.length ? within.map(s => ({ ...s, delay_ms: s.time - event.time,
        delay_from_post_hook_ms: event.after_time ? s.time - event.after_time : null })) : at5 ? ['none'] : ['unobserved'],
      at_plus_5s: at5 ? { sampled_at: at5.time, actual_delay_ms: at5.time - event.time, processes: processView(at5) } : null,
      at_end: end ? { sampled_at: end.time, processes: processView(end) } : null };
  });
  const followups = calls.filter(c => /^(followup|resume|steer)-delivered$/.test(c.arguments?.label ?? '')).map(call => {
    const same = call.owner?.thread_id && owned.some(e => e.owner?.thread_id) ? owned.some(e => e.owner?.thread_id === call.owner.thread_id) : null;
    const wait = calls.find(v => v.tool === 'wait' && v.owner?.thread_id === call.owner?.thread_id);
    const returned = wait && rpc.find(r => r.type === 'rpc' && r.direction === 'out' && r.server_pid === wait.server_pid && r.message.id === wait.request_id);
    const cancelled = wait && signalRows.find(r => r.signal === 'cancelled' && r.server_pid === wait.server_pid && r.request_id === wait.request_id);
    return { time: call.time, label: call.arguments.label, thread_id: call.owner?.thread_id ?? null,
      same_native_owner: same, evidence: 'fixture catalog call performed by metadata-identified caller',
      first_wait_returned_at: returned?.time ?? null, first_wait_cancelled_at: cancelled?.time ?? null,
      delivery_while_wait_pending: wait ? call.time >= wait.time && (!returned || call.time < returned.time) && (!cancelled || call.time < cancelled.time) : null };
  });
  const versions = [...new Set(rpc.filter(r => r.message?.method === 'initialize').map(r => r.message.params?.clientInfo?.version).filter(Boolean))];
  const hookNames = [...new Set(hooks.filter(h => h.type === 'hook').map(h => h.payload.hook_event_name))];
  const warnings = [];
  if (!calls.length) warnings.push('No fixture calls: setup/model/tool failure; no ownership result.');
  if (!hookNames.length) warnings.push('No hook delivery observed; trust/config support is unconfirmed.');
  if (calls.some(c => !c.owner?.thread_id)) warnings.push('At least one MCP call lacks host thread identity.');
  if (c.gate && !hooks.some(h => h.type === 'gate_start')) warnings.push('Requested phase gate never ran: intended interrupt phase is unqualified.');
  if (c.gate && !eventRows.some(e => e.source === 'native_tool_pre_hook' && /interrupt_agent/.test(e.action) && e.phase_at_event.some(p => p.phase === c.gate))) warnings.push('No native interrupt pre-hook established a landing inside the requested gate.');
  if (c.name === 'interrupt-wait' && !eventRows.some(e => e.source === 'native_tool_pre_hook' && /interrupt_agent/.test(e.action) && e.phase_at_event.some(p => p.phase === 'pending_wait'))) warnings.push('No native interrupt pre-hook established a landing during a pending wait.');
  if (c.name !== 'smoke' && !owned.length) warnings.push('No owned dispatch observed; startup cancellation may intentionally precede dispatch.');
  if (c.progress && !rpc.some(r => r.direction === 'out' && r.message?.method === 'notifications/progress')) warnings.push('No actual MCP progress sent; this is not a measured progress control.');
  if (calls.some(r => r.owner && (r.owner.model !== manifest.selection?.model || r.owner.reasoning_effort !== manifest.selection?.effort))) warnings.push('Observed per-call model/effort differs from requested selection (or metadata omitted it).');
  if (supervisor.some(r => r.type === 'wall_deadline')) warnings.push('Harness wall deadline reached; do not call it a host timeout.');
  const report = { scenario: c.name, mode: c.mode, measurement: c.measure, warnings,
    provenance: { prepared_only: manifest.prepared_only, command: readJSON(path.join(dir, 'command.json')), mcp_client_versions: versions },
    owner_identity_per_call: calls, received_signals: signalRows, host_events: eventRows,
    servers: rpc.filter(r => r.type === 'server_started'),
    hooks: { events_seen: hookNames, inputs: hooks.filter(h => h.type === 'hook').map(h => ({ time: h.time,
      event: h.payload.hook_event_name, fields: Object.keys(h.payload), payload: h.payload, process_cwd: h.process_cwd })) },
    attachment_gaps: owned.flatMap(e => phases.filter(p => p.execution_id === e.execution_id && ['dispatch_gap', 'between_waits'].includes(p.phase)).map(p => {
      const next = phases.find(n => n.execution_id === e.execution_id && n.time > p.time && n.phase === 'pending_wait' &&
        e.owner?.thread_id && n.full_meta?.['x-codex-turn-metadata']?.thread_id === e.owner.thread_id);
      return { execution_id: e.execution_id, owner: e.owner, phase: p.phase, start: p.time,
        next_wait: next?.time ?? null, observed_ms: (next?.time ?? end?.time ?? p.time) - p.time,
        catalog_reads: calls.filter(x => x.tool === 'catalog' && x.time >= p.time && x.time < (next?.time ?? end?.time ?? Infinity)).map(x => ({ time: x.time, owner: x.owner, label: x.arguments?.label })),
        lease_implemented: false };
    })),
    same_child_followup: followups.length ? followups : { outcome: 'not_observed' },
    saved_state: { fixture_history_rows: dispatches.length, fixture_state: dispatches.map(e => ({ execution_id: e.execution_id,
      owner: e.owner, cwd: e.cwd, canonical_cwd: e.canonical_cwd,
      result: readJSON(path.join(dir, `${e.execution_id}.result.json`)),
      result_existed_before_cleanup: end?.saved_results?.includes(`${e.execution_id}.result.json`) ?? null })),
      host_rollouts: filesBelow(path.join(dir, 'codex-home', 'sessions')), ephemeral: manifest.persistent === false,
      recovery_claim: 'File availability only. Native same-child follow-up is measured separately; no cold host resume attempted.' },
    clocks: samples.slice(1).map((s, i) => ({ time: s.time, wall_delta_ms: s.time - samples[i].time,
      mono_delta_ms: s.mono_ms - samples[i].mono_ms })).filter(d => d.wall_delta_ms > 1500 || Math.abs(d.wall_delta_ms - d.mono_delta_ms) > 250),
    cleanup: readJSON(path.join(dir, 'cleanup-verification.json')),
    limits: ['Passive fixture: no lease or host-triggered provider cleanup is implemented.',
      'Hooks and model markers perturb timing. A pre-hook brackets an attempted native operation, not successful delivery.',
      'Signal windows contain observations from all fixture connections; use owner/server/request identities before assigning cause.',
      'Missing +5 s samples mean unknown, never assumed survival or termination.',
      'Only cleanup-verification establishes recorded-PID absence; fresh heartbeats establish activity.',
      'No result from this file alone qualifies desktop, real providers, native MCP tasks, or a safe lease duration.'] };
  writeJSON(path.join(dir, 'analysis.json'), report);
  const summary = [`# ${c.name}: ${c.measure}`, '', `MCP calls: ${calls.length}. Servers: ${report.servers.length}. Hook events: ${hookNames.join(', ') || 'none'}.`,
    `Saved fixture dispatches: ${dispatches.length}. Follow-up delivery markers: ${followups.length}. Cleanup all absent: ${report.cleanup?.all_absent ?? 'unverified'}.`, '',
    ...warnings.map(w => `- ${w}`), '', 'Full owner, signal, phase, +5 s/end survival and hook evidence: analysis.json.',
    'This is a measurement row, not a host qualification verdict.', ''].join('\n');
  fs.writeFileSync(path.join(dir, 'analysis.md'), summary);
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node analyze.mjs RUN_DIRECTORY');
  const dir = path.resolve(process.argv[2]); analyze(dir); console.log(path.join(dir, 'analysis.json'));
}
