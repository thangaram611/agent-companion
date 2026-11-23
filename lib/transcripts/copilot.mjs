import { homedir } from 'node:os';
import { join } from 'node:path';
import { makeUsage } from '../usage.mjs';
import { output, status } from './common.mjs';

export function locate({ historyId, env }) {
  return historyId && join(String(env.COPILOT_HOME || '').trim() || join(env.HOME || homedir(), '.copilot'), 'session-state', historyId, 'events.jsonl');
}

const BOOKKEEPING = new Set(['session.model_change', 'assistant.turn_start', 'session.permissions_changed', 'session.auto_mode_resolved',
  'hook.start', 'hook.end', 'session.usage_checkpoint', 'permission.requested', 'permission.completed',
  'subagent.configured', 'subagent.selected',
  // Call telemetry and diagnostic snapshots, rather than new work records.
  'model.turn_started', 'model.model_call_started', 'model.captured_assignment_context',
  'model.model_call_success', 'model.turn_ended', 'model.messages_snapshot']);
export function parse(r, c) {
  const d = r.data ?? {};
  const prefix = `copilot:${c.state.sessionId ?? ''}:`;
  c.id = r.id ?? c.id;
  c.turnId = d.turnId ?? null;
  if (r.type === 'session.start') {
    c.format.version = { version: d.version, producer: d.producer, copilotVersion: d.copilotVersion };
    c.state.cwd = d.context?.cwd; c.state.sessionId = d.sessionId; return;
  }
  if (BOOKKEEPING.has(r.type)) return;
  if (r.type === 'abort' && ['user_abort', 'user_initiated'].includes(d.reason)) { c.emit('turn_end', { status: 'failed', reason: d.reason }); return; }
  if (r.type === 'session.task_complete') { c.emit('turn_end', { status: d.success === true ? 'completed' : d.success === false ? 'failed' : null, text: d.summary }); return; }
  if (r.type === 'session.info') { c.emit('preamble', { text: d.message, infoType: d.infoType }); return; }
  if (r.type === 'session.compaction_start' || r.type === 'session.compaction_complete') {
    c.emit('preamble', { text: d.summaryContent ?? '', data: d, status: r.type === 'session.compaction_start' ? 'running' : d.success === true ? 'completed' : d.success === false ? 'failed' : null }); return;
  }
  if (r.type === 'model.message' || r.type === 'model.response') {
    const message = r.type === 'model.message' ? d.message : d.response;
    if (message?.role !== 'assistant') { c.unknown(r); return; }
    // The shapes contain assistant text but no assistant.message samples to
    // establish duplication. Only these two forms sharing a call id upsert.
    const fields = { id: `${prefix}model:${d.callId}`, status: status(message.responses_message_status), phase: message.phase };
    c.emit('assistant', { ...fields, text: message.content });
    if (message.reasoning_text) c.emit('reasoning', { ...fields, id: `${fields.id}:reasoning`, text: message.reasoning_text });
    return;
  }
  if (r.type === 'subagent.started' || r.type === 'subagent.completed') {
    c.emit('tool', { id: `${prefix}subagent:${d.toolCallId}`, name: 'subagent', data: d, agentId: r.agentId, status: r.type === 'subagent.started' ? 'running' : 'completed' }); return;
  }
  if (r.type === 'human_response.recorded') { c.emit('user', { text: d.response.message, response: d.response, actor: d.actor, toolCallId: d.toolCallId }); return; }
  if (r.type === 'system.notification') {
    if (!['agent_idle', 'shell_completed'].includes(d.kind?.type)) { c.unknown(r); return; }
    c.emit('tool', { name: d.kind.type, data: d.kind, ...output(d.content), status: d.kind.type === 'shell_completed' ? 'completed' : null }); return;
  }
  if (['system.message', 'instruction.update'].includes(r.type)) { c.emit('preamble', { text: d.content, data: d }); return; }
  if (r.type === 'user.message' || r.type === 'assistant.message') { c.emit(r.type === 'user.message' ? 'user' : 'assistant', { text: d.content, toolRequests: d.toolRequests }); return; }
  if (['assistant.turn_end', 'session.shutdown'].includes(r.type)) { c.emit('turn_end', { status: r.type === 'assistant.turn_end' ? 'completed' : null }); return; }
  if (r.type === 'session.error') { c.emit('error', { error: { type: d.errorType, message: d.message }, status: 'failed', terminal: true }); return; }
  if (r.type === 'session.usage_record') {
    const u = d.usage;
    c.emit('usage', { scope: 'response', usage: makeUsage({ source: 'copilot-transcript', input: u.inputTokens, output: u.outputTokens, cached: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens, model: u.model }) }); return;
  }
  const calls = c.state.calls ??= new Map();
  if (r.type === 'tool.execution_start') {
    const base = { id: `${prefix}${d.toolCallId}`, name: d.toolName, input: d.arguments, status: 'running' };
    let item;
    if (d.toolName === 'bash') item = c.emit('command', { ...base, command: d.arguments.command, cwd: d.arguments.cwd ?? c.state.cwd ?? null, exitCode: null, output: '' });
    else if (['create', 'edit'].includes(d.toolName)) item = c.emit('edit', { ...base, paths: [{ path: d.arguments.path, change: d.toolName === 'create' ? 'add' : 'update' }] });
    else item = c.emit('tool', base);
    calls.set(d.toolCallId, item); return;
  }
  if (r.type === 'tool.execution_complete') {
    const previous = calls.get(d.toolCallId);
    if (!previous) { c.unknown(r); return; }
    const fields = { ...previous, nativeType: c.nativeType, status: d.success === true ? 'completed' : d.success === false ? 'failed' : null, ...output(d.result?.content) };
    if (previous.kind === 'command') fields.exitCode = typeof d.shellExecution?.exitCode === 'number' ? d.shellExecution.exitCode : null;
    if (d.fileEdits) {
      const changes = { create: 'add', edit: 'update', delete: 'delete' };
      if (d.fileEdits.some(f => !changes[f.kind])) { c.unknown(r); return; }
      fields.paths = d.fileEdits.map(f => ({ path: f.path, change: changes[f.kind] }));
      fields.patch = d.result?.detailedContent;
    }
    c.emit(previous.kind, fields); return;
  }
  c.unknown(r);
}
