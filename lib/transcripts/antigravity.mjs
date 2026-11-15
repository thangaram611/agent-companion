import { field, decode } from './protobuf.mjs';
import { output } from './common.mjs';

export function rows(db, sessionId, c) {
  const trajectory = db.prepare('SELECT trajectory_id FROM trajectory_meta WHERE trajectory_id=?').get(sessionId);
  const formats = db.prepare('SELECT DISTINCT step_format FROM steps ORDER BY step_format').all().map(r => r.step_format);
  c.format.version = formats.length === 1 ? formats[0] : formats.length ? formats : null;
  return trajectory ? db.prepare('SELECT * FROM steps ORDER BY idx').all() : [];
}
export function parse(r, c) {
  c.turnId = null;
  const payload = r.step_payload ?? Buffer.alloc(0);
  const get = (...path) => field(payload, ...path);
  const str = (...path) => { const value = get(...path); return value == null ? '' : Buffer.from(value).toString('utf8'); };
  const seconds = get(5, 1, 1), nanos = get(5, 1, 2);
  c.at = seconds == null ? null : new Date(Number(seconds) * 1000 + Number(nanos ?? 0n) / 1e6).toISOString();
  const status = ({ 2: 'running', 8: 'streaming', 3: 'completed' })[r.status];
  if (!status) { c.unknown(r); return; }
  const base = { status };
  if (r.step_type === 14) c.emit('user', { ...base, text: str(19, 2) });
  else if (r.step_type === 15) {
    c.emit('assistant', { ...base, text: str(20, 1), toolCall: get(20, 7) ? { id: str(20, 7, 1), name: str(20, 7, 2), arguments: str(20, 7, 3) } : null });
  } else if (r.step_type === 21) {
    let raw = get(28, 21);
    // Captures contain both a raw string and a field-1 string wrapper.
    if (raw) { try { const nested = decode(raw); if (nested.size === 1 && nested.get(1)?.[0]?.wire === 2) raw = nested.get(1)[0].value; } catch { /* raw text */ } }
    const code = get(28, 6);
    c.emit('command', { ...base, command: str(28, 23), cwd: str(28, 2) || null, exitCode: code == null ? null : Number(BigInt.asIntN(32, code)), ...output(raw ? Buffer.from(raw).toString('utf8') : '') });
  } else if (r.step_type === 5) {
    const name = str(5, 4, 2);
    if (!['write_to_file', 'replace_file_content'].includes(name)) { c.unknown(r); return; }
    const input = JSON.parse(str(5, 4, 3));
    c.emit('edit', { ...base, name, input, paths: [{ path: input.TargetFile, change: name === 'write_to_file' ? 'add' : 'update' }], text: str(10, 26) });
  } else c.unknown(r);
}
