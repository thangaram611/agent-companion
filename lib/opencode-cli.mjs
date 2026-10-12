// The CLI dialect shared by dispatch, onboarding and readiness diagnostics.
import { probeCommand } from './command-probe.mjs';

export function openCodeCliMajor(version) {
  return Number(String(version || '').match(/\bv?(\d+)\.\d+(?:\.\d+)?/)?.[1] || 0);
}

export function openCodeRunArgs({ bin, cwd, prompt, model, agent, title, skipPermissions }, run = probeCommand) {
  const version = run(bin, ['--version'], { timeoutMs: 5000 });
  const major = version.ok ? openCodeCliMajor(version.output) : 0;
  if (!major) throw new Error(`Could not determine OpenCode CLI version: ${version.output}`);
  // V2 otherwise attaches to a shared background service. CLI jobs must own
  // their server so terminating the child still terminates its work.
  const args = ['run', ...(major >= 2 ? ['--standalone'] : ['--dir', cwd]), '--format', 'json'];
  if (model) args.push('--model', model);
  if (agent) args.push('--agent', agent);
  if (title) args.push('--title', title);
  if (skipPermissions) args.push(major >= 2 ? '--auto' : '--dangerously-skip-permissions');
  args.push(prompt);
  return args;
}

export function probeOpenCodeAuth({ run, install }) {
  if (openCodeCliMajor(install.version) < 2) {
    const result = run(install.binary, ['models']);
    return { authenticated: Boolean(result.ok && result.output), detail: 'model listing' };
  }
  // V2 did not list this machine's working pinned model. Check native
  // connection metadata instead, without exposing provider secrets.
  const result = run(install.binary, ['auth', 'list', '--standalone', '--format', 'json']);
  if (!result.ok) return { authenticated: 'unknown', detail: 'native credential check failed' };
  let integrations;
  try { integrations = JSON.parse(result.output); }
  catch { return { authenticated: 'unknown', detail: 'native credential metadata was unreadable' }; }
  if (!Array.isArray(integrations)) return { authenticated: 'unknown', detail: 'native credential metadata was not a list' };
  return { authenticated: integrations.some(i => Array.isArray(i.connections) && i.connections.length > 0), detail: 'native provider connections' };
}
