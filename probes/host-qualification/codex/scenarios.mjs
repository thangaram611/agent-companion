// Every definition expands to scenario.json, prompt.txt, config.toml and command.json.
export const hookEvents = ['PreModelRequest', 'PostModelRequest', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];
const headless = (measure, extra = {}) => ({ mode: 'headless', status: 'ready', measure, ...extra });
const tui = measure => ({ mode: 'TUI', status: 'needs operator action', measure, wall_sec: 600 });
export const scenarios = {
  smoke: headless('Root catalog metadata and hook loading; no provider or child', { wall_sec: 110 }),
  identity: headless('Root, owning child, status sibling and same-child follow-up identity'),
  'cwd-worktree': headless('Worktree root cwd, requested child cwd, hook cwd and server cwd'),
  'cwd-symlink': headless('Logical symlink cwd versus canonical worktree cwd'),
  'cwd-validation': headless('Missing/relative/nonexistent cwd and same-execution different-workspace request'),
  'interrupt-startup': headless('Child interrupt before dispatch, inside the send pre-hook', { gate: 'startup' }),
  'interrupt-wait': headless('Child interrupt with attributable MCP wait pending'),
  'interrupt-dispatch-gap': headless('Child interrupt after dispatch acknowledgement, before first wait', { gate: 'dispatch_gap' }),
  'interrupt-between-waits': headless('Child interrupt after a bounded wait and owner catalog, before next wait', { gate: 'between_waits' }),
  'child-complete': headless('Normal native child completion while fake execution is live'),
  'native-close': headless('Native close if exposed; records unavailable without substituting interrupt', { status: 'needs operator action' }),
  'owner-graceful': headless('Natural exec completion and host exit while fake execution remains live'),
  'owner-sigint': headless('SIGINT of disposable host while a child waits', { injection: 'owner', signal: 'SIGINT' }),
  'owner-sigkill': headless('SIGKILL of disposable host while a child waits', { injection: 'owner', signal: 'SIGKILL' }),
  'server-sigkill': headless('Target MCP SIGKILL with root and an independent child connection still alive', { injection: 'server', signal: 'SIGKILL', witness: true }),
  'server-sigint': headless('Target MCP SIGINT with an independent connection still alive', { injection: 'server', signal: 'SIGINT', witness: true }),
  'followup-busy': headless('Ordinary followup_task during a pending wait and actual same-child delivery', { wait_sec: 30 }),
  steer: headless('Explicit native interrupt then followup_task; delivery and cancellation', { wait_sec: 90 }),
  'long-silent': headless('25–35 minute pending call versus tool_timeout_sec, without progress', { wait_sec: 1800, wall_sec: 2220, tool_timeout_sec: 1320 }),
  'long-progress': headless('Same long call with requested MCP progress tokens', { wait_sec: 1800, wall_sec: 2220, tool_timeout_sec: 1320, progress: true }),
  'tui-compact': tui('Manual /compact, connection and child identity, then same-child follow-up'),
  'tui-new': tui('/new, old execution survival, new root identity and old-child reachability'),
  'tui-restart': tui('Isolated config change and operator-confirmed MCP reload/restart'),
  'tui-stop': tui('Actual TUI stop key while child waits; compare with process SIGINT'),
  'tui-auto-compact': tui('Automatic compaction with an operator-selected low token threshold'),
  'suspend-wake': { ...tui('Operator suspend/wake; wall/monotonic deltas, heartbeat and pending connection'), wall_sec: 1800 },
  'clock-observe': tui('Observe externally authorized clock changes/delayed callbacks; harness never changes the system clock'),
};
export function definition(name, overrides = {}) {
  if (!Object.hasOwn(scenarios, name)) throw new Error(`Unknown scenario: ${name}`);
  const c = { name, wall_sec: 240, wait_sec: 90, provider_sec: 600, gate_sec: 45,
    after_phase_sec: 2, after_spawn_sec: 5, progress: false, progress_interval_ms: 10000,
    tool_timeout_sec: 120, ...scenarios[name], ...overrides };
  c.provider_sec = Math.max(c.provider_sec, c.wall_sec + 120);
  return c;
}
export function prompt(c, p) {
  const catalog = label => `Call fixture catalog with label ${JSON.stringify(label)}.`;
  const send = `Call fixture send exactly once with label "owned", message "initial", cwd ${JSON.stringify(p.child)}. Save its execution_id.`;
  const wait = `Call fixture wait for that execution_id with seconds ${c.wait_sec}. On timeout or tool error report it; never redispatch.`;
  const child = text => `Spawn one default native child named owner with fork_turns="none", no model or effort override. Give it this COMPLETE task: ${JSON.stringify(text)}. Keep its returned native target for all followups.`;
  const prefix = `Authorized isolated host measurement. Only native collaboration tools and the fixture MCP are allowed. No shell, installed plugins, real providers, browser, or file edits. Keep configured model and effort. Every spawn MUST use fork_turns="none". Discover the actual native schemas; never invent a tool or parameter. If an operation is unavailable, catalog with label "unavailable:<operation>" and report that fact. Do not call fixture stop unless explicitly requested below. Catalog is instantaneous and observational. Only send and wait are execution requests. Never treat a running response as finished work. Root launch cwd is ${JSON.stringify(p.workspace)}; requested child provider cwd is ${JSON.stringify(p.child)}. The fixture logs host metadata separately from these supplied paths.\n\n`;
  const polling = `Poll fixture catalog until the owned execution is in the requested phase (or a matching active gate exists) for at least ${c.after_phase_sec} seconds, and no earlier than ${c.after_spawn_sec} seconds after the owning child's SubagentStart in catalog.spawn_hooks. If that hook is absent, report the spawn offset as unknown. Use a bounded functions.exec loop with setTimeout(1000) and fixture catalog if available; otherwise bounded native waits between catalog calls. Maximum 90 seconds; if the phase never appears report "phase-unreached" and end. Do not blindly sleep N seconds and assume a phase. Catalog's time, phase.time and gate.time provide the timing cue. Model scheduling can overshoot; report the actual landing.`;
  const resume = `After at least 6 seconds of observation, use ordinary followup_task on the SAME saved child target: "Call fixture catalog with label resume-delivered and report any retained execution_id. Do not send, stop, or wait." Wait for its answer and report whether delivery succeeded. Do not spawn a replacement.`;
  if (c.name === 'smoke') return prefix + `${catalog('smoke-root')} Report server cwd and whether tools worked; end. Do not spawn children or start a provider.`;
  if (c.name === 'identity' || c.name.startsWith('cwd-')) {
    let steps = `${catalog('root')} ${child(`${catalog('child-before-send')} ${send} ${catalog('child-after-send')} Return execution_id without waiting or stopping.`)} Wait for the child's answer. Spawn a SECOND default native child, fork_turns="none", task "Call fixture catalog label status-sibling once; report active execution ids. Do not send or wait." Wait for that answer. `;
    if (c.name === 'cwd-validation') steps += `Follow up to the SAME owner: "Call send three times with message cwd-negative and label negative: first omit cwd, then cwd '.', then cwd ${p.missing}. Record each refusal. Call wait on your saved execution_id with seconds 0 and cwd ${p.other}; record workspace mismatch. Call catalog label followup-delivered." `;
    else steps += `Follow up to the SAME owner: "Call fixture catalog label followup-delivered with cwd ${p.child}; report saved execution_id. Do not start another provider." `;
    return prefix + steps + 'Wait for the answer, then end.';
  }
  if (c.name === 'child-complete' || c.name === 'owner-graceful') return prefix + `${child(`${send} ${catalog('before-child-complete')} Return immediately; leave the fake execution live.`)} Wait for child completion. ${catalog('after-child-complete')} ${c.name === 'child-complete' ? resume : ''} End normally; the supervisor observes live descendants after exec exit.`;
  let task = `${catalog('child-start')} ${send} `;
  if (c.gate === 'dispatch_gap') task += `${catalog('owner-dispatch-gap')} ${wait}`;
  else if (c.gate === 'between_waits') task += `Call wait seconds 1, then catalog label owner-between-waits, then ${wait}`;
  else task += wait;
  task += ` ${catalog('child-after-wait')} Return. If followup instructions arrive, carry them out on this same native child.`;
  let steps = catalog('before-spawn') + ' ';
  if (c.witness) steps += `First spawn a separate default native child named witness, fork_turns="none", complete task "Call fixture send once with label witness, cwd ${p.child}; call wait seconds 120 on its execution_id; report the result." `;
  steps += child(task) + '\n';
  if (c.mode === 'TUI') return prefix + steps + `Wait for the owner to finish. The operator will use the TUI and may send further instructions. Keep the native target in the transcript; do not end or stop the provider early.`;
  if (c.injection) return prefix + steps + `${polling} Requested phase: pending_wait. The external supervisor will signal the ${c.injection}. Keep the host alive using native waits; after 15 seconds call catalog label post-injection and report any error. End only after that observation. Do not restart or stop the fixture.`;
  if (c.name.startsWith('long-')) return prefix + steps + `Wait for the child. Do not interrupt, retry, shorten or replace its pending call. Report its actual elapsed time or timeout and end.`;
  steps += `${polling} Requested phase: ${c.gate ?? 'pending_wait'}.\n`;
  if (c.name === 'followup-busy') steps += `${catalog('before:followup_task')} Use ordinary followup_task (not send_message and not interrupt) on the busy owner with message "On delivery call fixture catalog label followup-delivered, then report the original wait outcome. Never dispatch again." ${catalog('after:followup_task')} Wait for the child and delivery; end.`;
  else if (c.name === 'native-close') steps += `${catalog('before:native-close')} If the native schema exposes close_agent, use it on owner; otherwise ${catalog('unavailable:native-close')} Do not substitute interrupt_agent. ${catalog('after:native-close')} ${resume} End.`;
  else steps += `${catalog('before:interrupt_agent')} Use the native interrupt_agent on owner now. ${catalog('after:interrupt_agent')} ${c.name === 'steer' ? `Use followup_task immediately on the SAME owner: "Explicit steering: abandon the previous wait; call catalog label steer-delivered and report retained execution_id. Do not send or stop." Wait for its answer; observe for 6 seconds and end.` : `${resume} End.`}`;
  return prefix + steps;
}
