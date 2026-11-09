// CLI-only fixture: no vendor imports, credentials or real Claude process.
import { fork } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function fakeClaudeBin(dir, name = 'claude-fake.mjs') {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\nimport { runFakeClaude } from ${JSON.stringify(import.meta.url)};\nrunFakeClaude();\n`, { mode: 0o700 });
  return path;
}

export function runFakeClaude() {
  const args = process.argv.slice(2), scenario = process.env.FAKE_CLAUDE_SCENARIO || 'success';
  const fail = (message) => { process.stderr.write(message + '\n'); process.exit(2); };
  const trace = (frame) => { if (process.env.FAKE_CLAUDE_TRACE) appendFileSync(process.env.FAKE_CLAUDE_TRACE, JSON.stringify(frame) + '\n'); };
  const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
  const value = (flag) => args[args.indexOf(flag) + 1];
  const required = ['-p', '--input-format', '--output-format', '--verbose', '--replay-user-messages',
    '--include-partial-messages', '--permission-mode', '--permission-prompts', '--disallowedTools'];
  if (required.some((flag) => args.filter((arg) => arg === flag).length !== 1) || args.includes('--bare') ||
      args.filter((arg) => ['--session-id', '--resume'].includes(arg)).length !== 1 ||
      value('--input-format') !== 'stream-json' || value('--output-format') !== 'stream-json' || value('--permission-prompts') !== 'none') fail('invalid Claude argv');
  if (!['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'].includes(value('--permission-mode'))) fail('invalid permission mode');
  if (args.includes('--effort') && !['low', 'medium', 'high', 'xhigh', 'max'].includes(value('--effort'))) fail('invalid effort');
  const denies = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--disallowedTools') + 4);
  if (JSON.stringify(denies) !== JSON.stringify(['mcp__plugin_agent-companion_agent-bridge__*', 'mcp__agent-bridge__*', 'Agent(agent-companion)'])) fail('missing recursion denies');
  const resumed = args.includes('--resume'), session_id = value(resumed ? '--resume' : '--session-id');
  if (!session_id || session_id.startsWith('--')) fail('missing session id');
  trace({ type: 'argv', args });
  const row = { pid: process.pid, ppid: process.ppid, pgid: process.pid, birthTime: `${process.pid}:${performance.timeOrigin}` };
  if (scenario === 'lingering') {
    const worker = fork(fileURLToPath(new URL('./controller/process-tree.mjs', import.meta.url)), ['root', 'ignore'],
      { detached: true, stdio: ['pipe', 'ignore', 'ignore', 'ipc'] });
    worker.on('message', (message) => process.send?.({ rows: [row, ...message.rows] }));
  } else process.send?.({ rows: [row] });
  let terminal = false, delivered = false, replayTimer;
  const scoped = (frame) => out({ session_id, parent_tool_use_id: null, ...frame });
  const result = (extra = {}) => {
    terminal = true;
    scoped({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', stop_reason: 'end_turn',
      result: 'alpha', num_turns: resumed ? 2 : 1, total_cost_usd: resumed ? 0.00216 : 0.00121,
      usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 14936, cache_creation_input_tokens: 3984,
        output_tokens_details: { thinking_tokens: 0 } }, modelUsage: { 'claude-haiku-5-5': {} }, ...extra });
  };
  const assistant = (content, extra = {}) => scoped({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-5-5', content }, ...extra });
  const event = (event, extra = {}) => scoped({ type: 'stream_event', event, ...extra });
  const partial = () => {
    event({ type: 'message_start', message: { id: 'a1' } });
    scoped({ type: 'system', subtype: 'thinking_tokens', thinking_tokens: 7 });
    event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private' } });
    event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'al' } });
    event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'pha' } });
  };
  if (scenario === 'bogus-resume') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0,
      errors: [`No conversation found with session ID: ${session_id}`] });
    process.stderr.write(`No conversation found with session ID: ${session_id}\n`);
    setTimeout(() => process.exit(1), 500);
  }
  if (scenario === 'stderr-flood') process.stderr.write('diagnostic\n'.repeat(100000));
  createInterface({ input: process.stdin }).on('line', (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return fail('invalid JSON request'); }
    trace(frame);
    if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt' && frame.request_id) {
      if (scenario === 'no-interrupt-ack') return;
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: [] } } });
      if (!terminal) {
        if (scenario === 'interrupt-tools') {
          scoped({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1',
            content: "The user doesn't want to proceed with this tool use... this call was stopped while running" }] } });
          scoped({ type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' } });
        }
        result({ subtype: 'error_during_execution', is_error: true, result: '',
          terminal_reason: scenario === 'interrupt-tools' ? 'aborted_tools' : 'aborted_streaming',
          num_turns: scenario === 'interrupt-tools' ? 3 : 1 });
        process.exitCode = 1;
      }
      return;
    }
    if (frame.type !== 'user' || delivered || !frame.uuid || frame.session_id !== session_id ||
        frame.parent_tool_use_id !== null || frame.message?.role !== 'user' || typeof frame.message.content !== 'string') return fail('invalid user request');
    delivered = true;
    if (scenario === 'no-init') return;
    if (scenario === 'malformed') process.stdout.write('not JSON\nnull\n');
    scoped({ type: 'command_lifecycle' });
    const init = { type: 'system', subtype: 'init', session_id: scenario === 'mismatch' ? 'wrong-session' : session_id,
      model: 'claude-haiku-5-5', tools: ['Bash'], mcp_servers: [], permissionMode: value('--permission-mode') };
    out(init);
    if (scenario === 'mismatch') return;
    const project = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake-project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${session_id}.jsonl`), JSON.stringify(frame) + '\n');
    const answer = () => {
      scoped({ ...frame, isReplay: true });
      if (scenario === 'retry') scoped({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 25, error: 'busy' });
      if (scenario === 'bash' || scenario === 'interrupt-tools') {
        assistant([{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'sleep 8 && echo slept' } }]);
        if (scenario === 'interrupt-tools') return;
        assistant([{ type: 'tool_use', id: 'bash-2', name: 'Bash', input: { command: 'echo second' } }]);
        scoped({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'slept' }] } });
        scoped({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-2', content: 'second' }] } });
      }
      partial();
      assistant([{ type: 'text', text: 'nested secret' }], { parent_tool_use_id: 'nested' });
      event({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'nested delta' } }, { parent_tool_use_id: 'nested' });
      scoped({ type: 'result', session_id: 'another-session', subtype: 'success', is_error: false, result: 'wrong' });
      for (const subtype of ['status', 'thinking_tokens']) scoped({ type: 'system', subtype });
      scoped({ type: 'rate_limit_event' });
      if (scenario === 'stdout-loss') { process.stdout.end(); return; }
      if (['interrupt', 'no-interrupt-ack'].includes(scenario)) return;
      assistant([{ type: 'text', text: 'alpha' }]);
      if (scenario === 'auth-error') result({ is_error: true, terminal_reason: 'api_error', result: 'Not logged in · Please run /login',
        duration_api_ms: 0, total_cost_usd: 0, modelUsage: {},
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
      else result();
      out(init); // A: repeated init must not reset the completed answer.
    };
    if (scenario === 'slow-replay') replayTimer = setTimeout(answer, 3000);
    else answer();
  });
  process.stdin.on('end', () => {
    clearTimeout(replayTimer);
    if (scenario !== 'lingering' && process.connected) process.disconnect();
  });
}
