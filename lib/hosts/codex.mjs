import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolveCodexExecutable } from '../codex-install.mjs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

function configDir(env = process.env) {
  const configured = String(env.CODEX_HOME || '').trim();
  return configured ? resolve(configured) : join(env.HOME || homedir(), '.codex');
}

export const codex = {
  id: 'codex',
  displayName: 'Codex',
  configDir,
  pluginDataDir: env => env.PLUGIN_DATA || join(configDir(env), 'plugins/data/agent-companion-agent-companion'),
  settingsName: 'config.toml',
  // Codex starts one MCP server per conversation, so a bridge serves the first session that calls it.
  bridgePerSession: true,
  oldAgentFile: 'agent-companion.toml',
  leadFromCall({ meta }) {
    const turn = meta?.['x-codex-turn-metadata'];
    const session = turn?.session_id;
    if (typeof session !== 'string' || !session.trim() || session.includes('${') || session.includes('}')) return null;
    const agent = turn.thread_source === 'subagent' ? turn.thread_id : null;
    if (turn.thread_source === 'subagent' && (typeof agent !== 'string' || !agent.trim())) return null;
    return { host: this.id, session, agent };
  },
  wakeStatus(lead, env) {
    if (lead.agent !== null) return { wake: null, reason: 'subagent' };
    return resolveCodexExecutable(env).executable ? { wake: 'codex_queue', reason: null }
      : { wake: null, reason: 'codex_unavailable' };
  },
  async wake(lead, notice, env) {
    if (lead.agent !== null) return { wake: null, reason: 'subagent' };
    const { executable, path: bin } = resolveCodexExecutable(env);
    if (!executable) return { wake: null, reason: 'codex_unavailable' };
    const child = spawn(bin, ['queue', '--thread', lead.session, '--message', notice], {
      env, stdio: 'ignore', signal: AbortSignal.timeout(10000), killSignal: 'SIGKILL', windowsHide: true,
    });
    const [code, signal] = await once(child, 'close');
    if (code !== 0) throw new Error(`codex queue exited with ${signal ?? code}`);
    return { wake: 'codex_queue', reason: 'queue_exited_zero' };
  },
  // Permission rules use the flat name. Tool calls use the namespace.
  toolPrefix: 'mcp__agent_bridge__',
  visibleToolPrefix: 'mcp__agent_bridge.',
};
