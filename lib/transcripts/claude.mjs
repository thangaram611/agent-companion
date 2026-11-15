import { usageFromClaudeResult, makeUsage } from '../usage.mjs';
import { text, output } from './common.mjs';

const BOOKKEEPING = new Set(['api-request-shape', 'api-request-blob', 'api-request', 'queue-operation', 'last-prompt', 'tools-used', 'mode', 'atis-latch',
  'permission-mode', 'session-owner', 'ai-title', 'file-history-delta', 'file-history-snapshot', 'custom-title', 'agent-name', 'pr-link']);
// turn_duration: timing only. away_summary: an interactive recap shown to the person, not model work.
const SYSTEM_BOOKKEEPING = new Set(['turn_duration', 'away_summary']);
export function parse(r, c) {
  if (r.version != null) c.format.version = r.version;
  const prefix = `claude:${r.sessionId ?? ''}:`;
  if (BOOKKEEPING.has(r.type)) return;
  if (r.type === 'system') {
    c.nativeType = `system/${r.subtype}`;
    if (r.subtype === 'compact_boundary') c.emit('preamble', { text: r.content, compactMetadata: r.compactMetadata });
    else if (r.subtype === 'informational') c.emit('preamble', { text: r.content, level: r.level });
    // A local UI command is not evidence of a shell process or an exit code.
    else if (r.subtype === 'local_command') c.emit('tool', { name: r.subtype, commandRun: r.commandRun, ...output(r.content) });
    else if (!SYSTEM_BOOKKEEPING.has(r.subtype)) c.unknown(r);
    return;
  }
  if (r.type === 'attachment') { c.emit('preamble', { text: text(r.rendered?.map(p => p.content)), attachment: r.attachment }); return; }
  if (r.type === 'cost-state') {
    for (const [model, u] of Object.entries(r.modelUsage ?? {})) c.emit('usage', {
      id: `${prefix}cost:${model}`, scope: 'session', usage: makeUsage({ source: 'claude-transcript', input: u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, output: u.outputTokens, cached: u.cacheReadInputTokens, cacheWrite: u.cacheCreationInputTokens, reasoning: u.thinkingTokens, model, cost: u.costUSD, costUnit: 'usd' }),
    });
    return;
  }
  if (!['user', 'assistant'].includes(r.type)) { c.unknown(r); return; }
  const content = typeof r.message.content === 'string' ? [{ type: 'text', text: r.message.content }] : r.message.content;
  // A tool-result user record is not a delivered prompt.
  if (r.type === 'user' && content.some(b => b.type === 'text' || b.type === 'image')) c.turnId = r.uuid ?? null;
  if (r.isApiErrorMessage) {
    c.emit('error', { error: { type: r.error, message: text(content) }, status: 'failed' }); return;
  }
  const calls = c.state.calls ??= new Map();
  for (const [index, b] of content.entries()) {
    const fields = { id: `${prefix}${r.uuid}:${index}` };
    c.nativeType = `${r.type}/${b.type}`;
    if (b.type === 'text' || b.type === 'thinking') c.emit(b.type === 'thinking' ? 'reasoning' : r.type, { ...fields, text: b.text ?? b.thinking });
    else if (r.type === 'user' && b.type === 'image') c.emit('user', { ...fields, image: { sourceType: b.source.type, mediaType: b.source.media_type } });
    else if (b.type === 'tool_use') {
      const id = `${prefix}${b.id}`;
      let item;
      const base = { id, status: 'running', name: b.name, input: b.input };
      if (b.name === 'Bash') item = c.emit('command', { ...base, command: b.input.command, cwd: r.cwd ?? null, exitCode: null, output: '' });
      else if (['Write', 'Edit'].includes(b.name)) item = c.emit('edit', { ...base, paths: [{ path: b.input.file_path, change: b.name === 'Write' ? 'add' : 'update' }] });
      else item = c.emit('tool', base);
      calls.set(b.id, item);
    } else if (b.type === 'tool_result') {
      const previous = calls.get(b.tool_use_id);
      if (!previous) { c.unknown(b, c.nativeType, `:${index}`); continue; }
      const fields = { ...previous, nativeType: c.nativeType, status: b.is_error ? 'failed' : 'completed', ...output(b.content) };
      if (previous.kind === 'command') {
        const match = /^Exit code (\d+)\b/.exec(text(b.content));
        fields.exitCode = b.is_error === false ? 0 : b.is_error && match ? Number(match[1]) : null;
        if (r.toolUseResult && typeof r.toolUseResult === 'object') Object.assign(fields, output([r.toolUseResult.stdout ?? '', r.toolUseResult.stderr ?? ''].filter(Boolean)));
      }
      if (previous.kind === 'edit' && r.toolUseResult?.filePath) {
        fields.paths = [{ path: r.toolUseResult.filePath, change: r.toolUseResult.type === 'create' ? 'add' : 'update' }];
        fields.patch = r.toolUseResult.structuredPatch;
      }
      c.emit(previous.kind, fields);
    } else c.unknown(b, c.nativeType, `:${index}`);
  }
  if (r.type === 'assistant' && r.message.usage) c.emit('usage', {
    id: `${prefix}${r.message.id}:usage`, scope: 'message', usage: usageFromClaudeResult(r.message, { model: r.message.model }),
  });
}
