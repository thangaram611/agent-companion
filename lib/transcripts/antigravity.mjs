import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { field, decode } from './protobuf.mjs';
import { output } from './common.mjs';

export function locate({ historyId, env }) {
  return historyId && join(antigravityDir(env), 'conversations', `${historyId}.db`);
}

export function antigravityDir(env) {
  return join(String(env.GEMINI_HOME || '').trim() || join(env.HOME || homedir(), '.gemini'), 'antigravity-cli');
}

function jsonFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'read.json')
      .map(entry => join(dir, entry.name));
  } catch { return []; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function hasUnreportedSubagent(sessionId, env) {
  const dir = join(antigravityDir(env), 'brain', sessionId, '.system_generated');
  const pending = new Set(jsonFiles(join(dir, 'subagents'))
    .filter(path => readJson(path)?.state !== 'SUBAGENT_STATE_KILLED').map(path => basename(path, '.json')));
  if (!pending.size) return false;
  for (const path of jsonFiles(join(dir, 'messages'))) pending.delete(readJson(path)?.sender);
  return pending.size > 0;
}

export function rows(db, sessionId, c) {
  if (!db.prepare('SELECT 1 FROM trajectory_meta WHERE cascade_id=?').get(sessionId)) return [];
  const formats = db.prepare('SELECT DISTINCT step_format FROM steps ORDER BY step_format').all().map(r => r.step_format);
  c.format.version = formats.length === 1 ? formats[0] : formats.length ? formats : null;
  const steps = db.prepare('SELECT * FROM steps ORDER BY idx').all();
  // Include this fact in the row cursor: appending a response retracts a
  // provisional terminal error even when agy left the error row untouched.
  for (const [i, step] of steps.entries()) {
    if (step.step_type === 17) step.terminal = i === steps.length - 1 || steps[i + 1].step_type === 14;
  }
  return steps;
}

const statuses = { 2: 'running', 3: 'completed', 6: 'cancelled', 7: 'failed', 8: 'streaming', 9: 'waiting_for_approval' };
const str = (bytes, ...path) => field(bytes, ...path)?.toString() ?? '';
function toolCall(bytes) {
  return { id: str(bytes, 1), name: str(bytes, 2), arguments: str(bytes, 3) };
}

export function parse(r, c) {
  const payload = r.step_payload, meta = field(payload, 5);
  const seconds = field(meta, 1, 1), nanos = field(meta, 1, 2);
  c.at = seconds == null ? null : Number(seconds * 1000n + (nanos ?? 0n) / 1000000n);
  const status = statuses[r.status];
  if (!status) { c.unknown(r); return; }
  if (r.step_type === 14) c.emit('user', { status, text: str(payload, 19, 2) });
  else if (r.step_type === 15) {
    const planner = field(payload, 20);
    const thinking = str(planner, 3);
    if (thinking) c.emit('reasoning', { status, text: thinking }, ':reasoning');
    const calls = decode(planner).get(7) ?? [];
    c.emit('assistant', { status, text: str(planner, 1), ...(calls.length ? { toolCalls: calls.map(({ value }) => toolCall(value)) } : {}) });
  } else if (r.step_type === 101) c.emit('system', { status, text: str(payload, 114, 4, 4) || str(payload, 114, 1) });
  else if (r.step_type === 17 && !field(meta, 4)) {
    const message = str(payload, 24, 3, 2);
    const type = message.match(/\b([A-Z_]+) \(code \d+\):/)?.[1] ?? 'provider_error';
    c.emit('error', { status: 'failed', error: { type, message }, terminal: r.terminal });
  } else if (r.step_type === 132) {
    const call = toolCall(field(meta, 4));
    const input = JSON.parse(call.arguments);
    const result = field(payload, 140, 2), text = str(result, 1);
    const failure = status === 'failed' ? str(r.error_details, 2) : '';
    const denied = /user denied permission/i.test(failure);
    const base = { status, name: call.name, toolCallId: call.id, input, ...output(text || (denied ? '' : failure)), ...(denied ? { denied: failure } : {}) };
    if (call.name === 'run_command') {
      // Only the result header describes the exit; stdout can contain the same words.
      const header = text.replace(/^(?:Created At: [^\n]*\n)?(?:Completed At: [^\n]*\n)?/, '');
      const code = header.match(/^Command exited with code (-?\d+)\.(?:\s|$)/);
      const background = header.startsWith('Tool is running as a background task with task id: ') || (!text && field(payload, 148, 1));
      c.emit('command', { ...base, command: str(result, 6, 2, 6) || input.CommandLine, cwd: str(result, 6, 2, 7) || null,
        status: status === 'completed' && background ? 'running' : status, exitCode: code ? Number(code[1]) : null });
    } else if (call.name === 'write_file' || call.name === 'edit_file') {
      c.emit('edit', { ...base, paths: [{ path: input.Path, change: call.name === 'write_file' ? 'add' : 'update' }] });
    } else c.emit('tool', base);
  } else c.unknown(r);
}
