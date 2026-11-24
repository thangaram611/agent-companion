import { homedir } from 'node:os';
import { join } from 'node:path';
import { usageFromOpenCodeInfo } from '../usage.mjs';
import { text, output, status, exitCode } from './common.mjs';

export function locate({ env }) {
  return env.OPENCODE_DB || join(String(env.XDG_DATA_HOME || '').trim() || join(env.HOME || homedir(), '.local/share'), 'opencode', 'opencode.db');
}

const BOOKKEEPING = new Set(['model-switched', 'agent-switched']);
export function rows(db, sessionId, c) {
  c.format.version = db.prepare('SELECT id FROM migration ORDER BY id DESC LIMIT 1').get()?.id ?? null;
  c.state.cwd = db.prepare('SELECT directory FROM session_v2 WHERE id=?').get(sessionId)?.directory ?? null;
  const messages = db.prepare('SELECT * FROM session_message WHERE session_id=? ORDER BY seq').all(sessionId);
  // 2.4.0 stores a message's parts in session_part and leaves `content` empty.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_part'").get()) return messages;
  const parts = Map.groupBy(db.prepare('SELECT message_id, data FROM session_part WHERE session_id=? ORDER BY message_id, ordinal').all(sessionId), p => p.message_id);
  return messages.map(m => parts.has(m.id) ? { ...m, parts: parts.get(m.id).map(p => p.data) } : m);
}
export function parse(r, c) {
  const d = JSON.parse(r.data);
  if (BOOKKEEPING.has(r.type)) return;
  if (r.type === 'user') { c.turnId = r.id; c.emit('user', { text: d.text }); return; }
  if (r.type === 'idle') {
    if (d.error) c.emit('error', { error: { type: d.error.type, message: d.error.message }, status: 'failed' });
    c.emit('turn_end', { id: `opencode:${r.session_id}:${r.id}:end`, status: d.outcome === 'succeeded' ? 'completed' : d.outcome === 'failed' ? 'failed' : null }); return;
  }
  if (r.type === 'synthetic' && d.metadata?.source === 'shell') {
    const meta = d.metadata;
    const command = c.state.shells?.get(meta.shellID);
    const body = d.text?.match(/^<background-result\b(?:[^">]|"[^"]*")*>\n([\s\S]*)\n<\/background-result>$/);
    if (command && body && ['completed', 'failed', 'cancelled'].includes(meta.state)) {
      const final = { ...command, status: meta.state, exitCode: exitCode(meta.exit) };
      delete final.truncated;
      c.emit('command', { ...final, ...output(body[1], meta.truncated) });
      return;
    }
  }
  if (r.type !== 'assistant') { c.unknown(r); return; }
  for (const [index, part] of (r.parts?.map(p => JSON.parse(p)) ?? d.content ?? []).entries()) {
    c.nativeType = `assistant/${part.type}`;
    const base = { id: `opencode:${r.session_id}:${r.id}:${part.id ?? index}`, status: d.time?.completed ? 'completed' : null };
    if (part.type === 'text' || part.type === 'reasoning') c.emit(part.type === 'text' ? 'assistant' : 'reasoning', { ...base, text: part.text });
    else if (part.type === 'tool') {
      const s = part.state;
      const fields = { ...base, status: status(s.status), name: part.name, input: s.input, ...output(s.content, s.metadata?.truncated) };
      // No exit (measured on 2.3.0): a command its timeout killed has the
      // signal and failed; one a cancel or interrupt stopped is `interrupted`,
      // unfinished as the summary calls a command its job's end cut off.
      const killed = s.metadata?.exit != null ? {} : s.metadata?.interrupted ? { status: 'unfinished' }
        : s.metadata?.signal ? { status: 'failed', signal: s.metadata.signal } : {};
      if (part.name === 'shell') {
        if (s.metadata?.status === 'running') fields.status = 'running';
        const command = c.emit('command', { ...fields, command: s.input.command, cwd: s.input.workdir ?? c.state.cwd, exitCode: exitCode(s.metadata?.exit), ...killed });
        if (fields.status === 'running' && s.metadata?.shellID) (c.state.shells ??= new Map()).set(s.metadata.shellID, command);
      } else if (['write', 'edit'].includes(part.name)) {
        const changes = { added: 'add', modified: 'update', deleted: 'delete' };
        // The write result explicitly distinguishes creating from overwriting.
        const change = part.name === 'edit' || text(s.content).startsWith('Wrote file successfully:') ? 'update' : 'add';
        if (s.metadata?.files?.some(f => !changes[f.status])) { c.unknown(part, c.nativeType, `:${index}`); continue; }
        c.emit('edit', { ...fields, paths: s.metadata?.files?.map(f => ({ path: f.file, change: changes[f.status] })) ?? [{ path: s.input.path, change }], files: s.metadata?.files });
      } else c.emit('tool', fields);
    } else c.unknown(part, c.nativeType, `:${index}`);
  }
  if (d.tokens) c.emit('usage', { id: `opencode:${r.session_id}:${r.id}:usage`, nativeType: 'assistant', scope: 'message', usage: usageFromOpenCodeInfo({ ...d, modelID: d.model?.id }, 'opencode-transcript') });
}
