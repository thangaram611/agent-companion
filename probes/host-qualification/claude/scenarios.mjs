// Each entry materializes its own prompt.txt, settings.json, agents and MCP config.
const stop = (phase, extra = {}) => ({ mode: 'headless', action: 'stop', phase, ...extra });
const tui = (action, measure) => ({ mode: 'TUI', action, phase: 'pending-wait', measure, wallSec: 600, waitSec: 180 });
export const scenarios = {
  smoke: stop('pending-wait', { wallSec: 130, budget: 0.50, measure: 'Identity, pending-call TaskStop, +5 s tree survival, same-child resume' }),
  'stop-startup': stop('startup', { startupGateSec: 25, measure: 'TaskStop before dispatch, while first send is held in a hook' }),
  'stop-pending': stop('pending-wait', { measure: 'Cancellation of a pending attributable wait' }),
  'stop-dispatch-gap': stop('dispatch-to-first-wait', { gateWaitOrdinal: 1, gapGateSec: 30, measure: 'Stop after send acknowledgement, before the first MCP wait' }),
  'stop-between-waits': stop('between-waits', { waitSec: 3, gateWaitOrdinal: 2, gapGateSec: 30, measure: 'Stop between returned waits; catalog does not renew attachment' }),
  'normal-completion': { mode: 'headless', action: 'complete', phase: 'dispatch-to-first-wait', measure: 'SubagentStop while its fake provider still runs' },
  'parent-exit': { mode: 'headless', action: 'exit', phase: 'pending-wait', measure: 'Natural print-mode parent exit during live child work' },
  'parent-sigkill': { mode: 'headless', action: 'parent-kill', phase: 'pending-wait', measure: 'Parent SIGKILL, EOF, hooks and descendant survival' },
  'fixture-sigkill': { mode: 'headless', action: 'fixture-kill', signal: 'SIGKILL', phase: 'pending-wait', independent: true,
    measure: 'Server loss, child error, reconnect versus respawn, independent connection survival' },
  'fixture-sigint': { mode: 'headless', action: 'fixture-kill', signal: 'SIGINT', phase: 'pending-wait', independent: true,
    measure: 'Server SIGINT with parent alive; compare host-initiated SIGINT' },
  'busy-followup': { mode: 'headless', action: 'followup', phase: 'pending-wait', waitSec: 40,
    measure: 'SendMessage to busy child: receipt before or after wait return/cancellation' },
  'explicit-steering': { mode: 'headless', action: 'steer', phase: 'pending-wait', waitSec: 40,
    measure: 'Explicit instruction to change course via native SendMessage; distinguish from native interrupt' },
  cwd: { mode: 'headless', action: 'cwd', cwdCase: 'explicit', measure: 'Parent cwd, child-reported cwd, hook cwd, received cwd and server cwd' },
  'cwd-inherited': { mode: 'headless', action: 'cwd', cwdCase: 'inherited', measure: 'Child chooses cwd from native host context without a parent path' },
  'cwd-missing': { mode: 'headless', action: 'cwd', cwdCase: 'missing', measure: 'Missing context: clarify without dispatch' },
  'cwd-ambiguous': { mode: 'headless', action: 'cwd', cwdCase: 'ambiguous', measure: 'Two possible workspaces: clarify without choosing one' },
  'cwd-relative': { mode: 'headless', action: 'cwd', cwdCase: 'relative', measure: 'Fixture refuses a relative cwd' },
  'cwd-nonexistent': { mode: 'headless', action: 'cwd', cwdCase: 'nonexistent', measure: 'Fixture refuses an absent directory' },
  'cwd-symlink': { mode: 'headless', action: 'cwd', cwdCase: 'symlink', measure: 'Logical path versus canonical identity through a symlink in this worktree' },
  'cwd-change': { mode: 'headless', action: 'cwd', cwdCase: 'change', measure: 'Same-child wait refuses a different canonical workspace' },
  'identity-negative': { mode: 'headless', action: 'identity', measure: 'Parent-forged thread cleared; owner-bound dispatch rejected; catalog allowed' },
  'long-silent': { mode: 'headless', action: 'long', phase: 'pending-wait', waitSec: 1980, wallSec: 2160, budget: 1.50,
    measure: '33-minute pending wait without progress against per-server timeout' },
  'long-progress': { mode: 'headless', action: 'long', phase: 'pending-wait', waitSec: 1980, wallSec: 2160, budget: 1.50, progress: true,
    measure: 'Same long wait with progressToken notifications every 10 seconds' },
  clear: tui('clear', 'Interactive /clear: session/owner identity, connection and saved transcript availability'),
  compact: tui('compact', 'Manual /compact: PreCompact, connection and owner continuity'),
  'settings-restart': tui('settings-restart', 'Run-local settings/MCP edit; observe whether host restarts or requires /mcp action'),
  'ui-stop': tui('ui-stop', 'Native /tasks UI stop and attempted same-child continuation'),
  'tui-steering': tui('tui-steering', 'Operator message directly in the busy child transcript; actual UI steering semantics'),
  'native-close': tui('native-close', 'TUI /exit during live work'),
  'auto-compact': tui('auto-compact', 'Operator-induced context pressure; qualify only on PreCompact trigger=auto'),
  'suspend-wake': tui('suspend-wake', 'Operator-controlled machine sleep/wake, heartbeat and callback gaps'),
  'clock-jump': tui('clock-jump', 'Operator-controlled disposable-machine clock change; timestamp versus monotonic deltas'),
  'delayed-callbacks': tui('delayed-callbacks', 'Operator SIGSTOP/SIGCONT of recorded fixture server; delayed callbacks versus host loss'),
};

export function configuration(name, overrides = {}) {
  if (!scenarios[name]) throw Error(`Unknown scenario ${name}`);
  const config = { name, wallSec: 210, budget: 1, model: 'haiku', waitSec: 60, eventDelaySec: 1,
    serverTimeoutMs: 1320000, progress: false, progressSec: 10, startupGateSec: 0,
    gateWaitOrdinal: 0, gapGateSec: 0, ...scenarios[name], ...overrides };
  config.workSec ??= config.wallSec + 120;
  return config;
}

export function prompt(config, dir) {
  const parentCwd = dir + '/workspace';
  const childCwd = dir + '/child-workspace';
  const catalog = 'mcp__fixture__catalog';
  const observe = (phase = config.phase, delaySec = config.eventDelaySec) =>
    `Call mcp__observer__observe with ${JSON.stringify({ phase, delaySec,
      ...(phase && (config.startupGateSec || config.gapGateSec) ? { requireGate: true } : {}),
      ...(config.afterSpawnSec !== undefined ? { afterSpawnSec: config.afterSpawnSec } : {}), timeoutSec: 90 })}.`;
  const base = `This is an isolated host measurement with local fake workers, not a coding task.
Use only fixture-native (and fixture-control if specifically requested) plus Agent, SendMessage, TaskStop, TaskOutput and the supplied MCP tools. No shell, files, web, plugins or real providers.
Record native agent IDs and actual tool outcomes briefly. Never infer process death from a native acknowledgement. Never invent an owner thread; the hook supplies it. Parent cwd is ${parentCwd}.
If a step fails, report it once; do not improvise a replacement child or another execution.
`;
  const child = `Call ${catalog} once reporting childCwd from YOUR host context and parentCwd=${parentCwd} (say unknown if unavailable).
Call send once with cwd=${childCwd}, childCwd and parentCwd. Save executionId.
Call catalog once with marker=after-dispatch (observational, no attachment).
Then call wait with that executionId, cwd=${childCwd}, seconds=${config.waitSec}.
After a running wait returns, call catalog once (read-only, no attachment), then re-wait with the same arguments, at most three waits total.
If you receive a follow-up marker, call catalog with that exact marker as soon as you can act on it.
On connection failure, report the actual error and finish; no automatic send retry.`;
  const spawn = `Spawn one BACKGROUND fixture-native with this message:\n${child}\n`;
  const resume = `After observing at least six seconds, SendMessage to that SAME native child: "Continue this conversation. Call ${catalog} with marker=resume-confirmed and report your retained executionId, then finish. Do not send new work." Wait for its reply; a refusal is a result, do not replace it.`;
  if (config.action === 'identity') return base + `As the PARENT, call catalog, then send with thread="fabricated-owner" and cwd=${childCwd}. Expect refusal. Spawn fixture-native to call catalog once with marker=real-child, then finish. Report actual responses.`;
  if (config.action === 'cwd') {
    const value = { explicit: childCwd, inherited: 'the absolute cwd from your OWN host context',
      missing: 'unknown', ambiguous: `${childCwd} OR ${parentCwd}, neither selected`, relative: './child-workspace',
      nonexistent: dir + '/does-not-exist', symlink: dir + '/child-link', change: childCwd }[config.cwdCase];
    let instruction = `Call catalog with childCwd from your own host context (unknown if unavailable), parentCwd=${parentCwd}, and marker=cwd-report. Requested working directory: ${value}. `;
    instruction += ['missing', 'ambiguous'].includes(config.cwdCase)
      ? 'Ask for the missing choice; do not dispatch or substitute your own cwd.'
      : `Call send once with cwd=${value} exactly (for inherited context use its actual path). Preserve an error; do not repair the test input. Report received/canonical cwd.`;
    if (config.cwdCase === 'change') instruction += ` Then wait on that executionId with seconds=0, cwd=${parentCwd}; report the workspace mismatch without retrying.`;
    return base + `Spawn fixture-native with: ${instruction}\nWait for its answer and finish.`;
  }
  if (config.action === 'complete') return base + `Spawn fixture-native with: "Call catalog; send once with cwd=${childCwd}; retain executionId and immediately finish without waiting or stopping it." Wait for its natural completion. ${observe(null, 6)} ${resume}`;
  if (config.action === 'stop') return base + spawn + observe() + `
Use TaskStop on that exact background child NOW, even if the observer reports a missed phase (record the miss).
${observe(null, 6)} ${resume} Finish briefly.`;
  if (config.action === 'exit') return base + spawn + observe() + '\nFinish YOUR parent answer immediately while the child is still waiting. Do not TaskStop it; this measures natural parent exit.';
  if (config.action === 'parent-kill') return base + spawn + observe() + '\nThe external runner will SIGKILL this disposable host. Keep the parent active using observer.observe with delaySec=60; do not stop the child or finish first.';
  if (config.action === 'fixture-kill') return base + `First spawn BACKGROUND fixture-control with: "Use mcp__fixture_control__send once with cwd=${childCwd}; then wait with seconds=90 on its executionId. Report errors honestly."\n` + spawn + observe() + `
The runner kills only the fixture server after both connections are waiting. Observe with delaySec=8.
SendMessage to the SAME fixture-native child: "Call catalog with marker=resume-confirmed once; report its result or connection error, and your retained executionId. Do not send new work."
Wait for its actual reply. TaskStop the control child only after this observation, then finish.`;
  if (config.action === 'followup' || config.action === 'steer') {
    const marker = config.action === 'steer' ? 'steering-delivered' : 'followup-delivered';
    const message = config.action === 'steer'
      ? `Change course now: do not re-wait. As soon as this instruction is delivered, call stop on your executionId (record-only), then catalog with marker=${marker}, and finish.`
      : `Ordinary follow-up, no interrupt requested: when this message reaches you, call catalog with marker=${marker}, then finish.`;
    return base + spawn + observe() + `\nSendMessage to that SAME busy child with exactly: "${message}"\nUse TaskOutput to await its answer. Report actual native delivery result and whether the wait had ended. Do not simulate steering with TaskStop.`;
  }
  if (config.action === 'long') return base + `Spawn BACKGROUND fixture-native with: "Call send with cwd=${childCwd}; call wait exactly ONCE with its executionId, cwd=${childCwd}, seconds=${config.waitSec}. Record whether the actual return is running, finished, timeout, error, or a host background-task handle; then finish. Do not retry."
Wait for this child using native TaskOutput (repeat bounded native waits if necessary), then finish. No early TaskStop. MCP per-server timeout=${config.serverTimeoutMs} ms; progress=${config.progress}.`;
  return base + spawn + '\nReturn PARENT_READY with the native child ID while leaving it running. The operator will perform the named TUI action. On a later operator prompt attempt SendMessage to that SAME child with marker=resume-confirmed; never create a replacement. No automatic /clear, /compact or /exit.';
}

export function settings(dir, hookCommand, config) {
  const command = { type: 'command', command: hookCommand, timeout: Math.max(5, config.startupGateSec + 5, config.gapGateSec + 5) };
  const hooks = Object.fromEntries(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreCompact', 'Stop']
    .map(event => [event, [{ hooks: [command] }]]));
  hooks.PreToolUse = [
    { matcher: '^mcp__fixture(__|_control__)(catalog|send|wait|stop)$', hooks: [command] },
    { matcher: '^TaskStop$', hooks: [command] },
    { matcher: '^(Agent|SendMessage|TaskOutput|SubagentHandback|mcp__observer__observe)$', hooks: [command] },
  ];
  for (const event of ['PostToolUse', 'PostToolUseFailure']) hooks[event] = [{ matcher: '.*', hooks: [command] }];
  return { autoMemoryEnabled: false, syncClaudeAiPlugins: false, syncClaudeAiSkills: false,
    disableClaudeAiConnectors: true, enabledPlugins: { 'agent-companion@inline': false },
    permissions: { allow: ['Agent(fixture-native)', 'Agent(fixture-control)', 'SendMessage', 'TaskStop', 'TaskOutput',
      'mcp__fixture__*', 'mcp__fixture_control__*', 'mcp__observer__*'] }, hooks };
}
