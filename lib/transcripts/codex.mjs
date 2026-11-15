import { makeUsage } from '../usage.mjs';
import { text, output, status, exitCode } from './common.mjs';

// Transport mirrors have a richer item_completed record; context has no item.
const BOOKKEEPING = new Set(['world_state', 'turn_context', 'inter_agent_communication_metadata']);
const EVENTS = new Set(['task_started', 'thread_settings_applied']);
const RESPONSE_MIRRORS = new Set(['function_call', 'function_call_output']);
const RESPONSE_BOOKKEEPING = new Set(['additional_tools', 'configuration_update']); // Definitions/settings, not executions.
function usage(u, c, scope) {
  if (!u) return;
  c.emit('usage', { usage: makeUsage({ source: 'codex-transcript', input: u.input_tokens, output: u.output_tokens, cached: u.cached_input_tokens, cacheWrite: u.cache_write_input_tokens, reasoning: u.reasoning_output_tokens, total: u.total_tokens }), scope });
}
export function parse(r, c) {
  const p = r.payload ?? {};
  c.turnId = p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id ?? c.turnId;
  if (r.type === 'session_meta') {
    c.format.version = p.cli_version ?? null;
    if (p.base_instructions?.text) c.emit('preamble', { text: p.base_instructions.text });
  } else if (BOOKKEEPING.has(r.type)) return;
  else if (r.type === 'compacted') c.emit('preamble', {
    text: p.message || (p.replacement_history ?? []).filter(item => item.type === 'message').map(item => text(item.content)).join('\n'),
    replacementHistory: p.replacement_history, retainedContext: p.retained_context,
  });
  else if (r.type === 'token_usage_record') usage(p.usage, c, 'response');
  else if (r.type === 'response_item') {
    c.nativeType = `response_item/${p.type}`;
    if (RESPONSE_MIRRORS.has(p.type) || RESPONSE_BOOKKEEPING.has(p.type)) return;
    if (p.type === 'custom_tool_call') {
      const calls = c.state.customCalls ??= new Map();
      calls.set(p.call_id, c.emit('tool', { id: `codex:${c.state.sessionId}:custom:${p.call_id}`, name: p.name, input: p.input, status: status(p.status) }));
    } else if (p.type === 'custom_tool_call_output') {
      const previous = c.state.customCalls?.get(p.call_id);
      if (!previous) { c.unknown(r); return; }
      c.emit('tool', { ...previous, nativeType: c.nativeType, ...output(p.output) });
    } else if (p.type === 'agent_message') {
      // Inter-agent communication is not a reply to the person. Show plaintext,
      // keeping opaque encrypted content out of the normalized item.
      c.emit('tool', { id: `codex:${c.state.sessionId}:${c.turnId}:${p.id}`, name: p.type, author: p.author, recipient: p.recipient, text: text(p.content.filter(part => part.type === 'input_text')) });
    } else if (p.type === 'message') {
      const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds ?? [];
      // User/assistant messages are duplicated by UserMessage/AgentMessage.
      if (p.role === 'assistant' || (p.role === 'user' && kinds.includes('user.text'))) return;
      if (['system', 'developer', 'user'].includes(p.role)) c.emit('preamble', { text: text(p.content), role: p.role });
      else c.unknown(r);
    } else if (p.type === 'reasoning') c.emit('reasoning', { id: `codex:${c.state.sessionId}:${c.turnId}:${p.id}`, text: text(p.summary) || text(p.content) });
    else c.unknown(r);
  } else if (r.type === 'event_msg') {
    c.nativeType = `event_msg/${p.type}`;
    if (EVENTS.has(p.type)) return;
    if (p.type === 'token_count') usage(p.info?.total_token_usage, c, 'thread');
    else if (p.type === 'turn_aborted') c.emit('turn_end', { id: `codex:${c.state.sessionId}:${c.turnId}:end`, status: 'failed', reason: p.reason });
    else if (p.type === 'task_complete') {
      if (p.error) c.emit('error', { error: { type: typeof p.error.codex_error_info === 'string' ? p.error.codex_error_info : Object.keys(p.error.codex_error_info ?? {})[0] ?? 'task_complete', message: p.error.message }, status: 'failed' });
      c.emit('turn_end', { id: `codex:${c.state.sessionId}:${c.turnId}:end`, status: p.error ? 'failed' : 'completed', text: p.last_agent_message });
    } else if (p.type === 'item_completed') {
      const i = p.item;
      c.nativeType += `/${i.type}`;
      const fields = { id: `codex:${c.state.sessionId}:${c.turnId}:${i.id}`, status: status(i.status) ?? 'completed' };
      if (i.type === 'UserMessage' || i.type === 'AgentMessage') c.emit(i.type === 'UserMessage' ? 'user' : 'assistant', { ...fields, text: text(i.content), ...(i.phase ? { phase: i.phase } : {}) });
      else if (i.type === 'Reasoning') c.emit('reasoning', { ...fields, text: text(i.summary_text) || text(i.raw_content) });
      else if (i.type === 'CommandExecution') c.emit('command', { ...fields, command: i.command, cwd: i.cwd ?? null, exitCode: exitCode(i.exit_code), ...output(i.aggregated_output) });
      else if (['McpToolCall', 'SubAgentActivity', 'CollabAgentToolCall'].includes(i.type)) {
        const { type, id, kind, ...rest } = i;
        c.emit('tool', { ...rest, ...fields, name: i.tool ?? kind, ...(i.type === 'McpToolCall' ? { input: i.arguments, ...output(i.result?.content) } : {}) });
      }
      // Extension is a generic container (web.search, clock.sleep, ...): kind names the tool.
      else if (i.type === 'Extension') { const { type, id, kind, ...rest } = i; c.emit('tool', { ...rest, ...fields, name: kind }); }
      else if (i.type === 'ImageView') c.emit('tool', { ...fields, name: i.type, path: i.path });
      else if (i.type === 'ContextCompaction') c.emit('preamble', { ...fields, text: 'Context compacted' });
      else if (i.type === 'FileChange') {
        if (Object.values(i.changes).some(change => !['add', 'update', 'delete'].includes(change.type))) { c.unknown(r); return; }
        c.emit('edit', { ...fields, paths: Object.entries(i.changes).map(([path, change]) => ({ path, change: change.type })), changes: i.changes });
      } else c.unknown(r);
    } else c.unknown(r);
  } else c.unknown(r);
  if (r.type === 'session_meta') c.state.sessionId = p.id ?? p.session_id;
}
