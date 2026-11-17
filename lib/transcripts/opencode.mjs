import { usageFromOpenCodeInfo } from '../usage.mjs';
import { text, output, status, exitCode } from './common.mjs';

const BOOKKEEPING = new Set(['model-switched', 'agent-switched']);
export function rows(db, sessionId, c) {
  c.format.version = db.prepare('SELECT id FROM migration ORDER BY id DESC LIMIT 1').get()?.id ?? null;
  c.state.cwd = db.prepare('SELECT directory FROM session_v2 WHERE id=?').get(sessionId)?.directory ?? null;
  return db.prepare('SELECT * FROM session_message WHERE session_id=? ORDER BY seq').all(sessionId);
}
export function parse(r, c) {
  const d = JSON.parse(r.data);
  if (BOOKKEEPING.has(r.type)) return;
  if (r.type === 'user') { c.turnId = r.id; c.emit('user', { text: d.text }); return; }
  if (r.type === 'idle') {
    if (d.error) c.emit('error', { error: { type: d.error.type, message: d.error.message }, status: 'failed' });
    c.emit('turn_end', { id: `opencode:${r.session_id}:${r.id}:end`, status: d.outcome === 'succeeded' ? 'completed' : d.outcome === 'failed' ? 'failed' : null }); return;
  }
  if (r.type !== 'assistant') { c.unknown(r); return; }
  for (const [index, part] of (d.content ?? []).entries()) {
    c.nativeType = `assistant/${part.type}`;
    const base = { id: `opencode:${r.session_id}:${r.id}:${part.id ?? index}`, status: d.time?.completed ? 'completed' : null };
    if (part.type === 'text' || part.type === 'reasoning') c.emit(part.type === 'text' ? 'assistant' : 'reasoning', { ...base, text: part.text });
    else if (part.type === 'tool') {
      const s = part.state;
      const fields = { ...base, status: status(s.status), name: part.name, input: s.input, ...output(s.content, s.metadata?.truncated) };
      // A command its timeout killed has no exit, only the signal (measured on 2.3.0).
      const killed = s.metadata?.exit == null && s.metadata?.signal ? { status: 'failed', signal: s.metadata.signal } : {};
      if (part.name === 'shell') c.emit('command', { ...fields, command: s.input.command, cwd: s.input.cwd ?? c.state.cwd, exitCode: exitCode(s.metadata?.exit), ...killed });
      else if (['write', 'edit'].includes(part.name)) {
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
