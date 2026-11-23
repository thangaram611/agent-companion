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
    if (lead.agent !== null) return;
    const { executable, path: bin } = resolveCodexExecutable(env);
    if (!executable) return;
    const child = spawn(bin, ['queue', '--thread', lead.session, '--message', notice], {
      env, stdio: 'ignore', signal: AbortSignal.timeout(10000), killSignal: 'SIGKILL', windowsHide: true,
    });
    const [code, signal] = await once(child, 'close');
    if (code !== 0) throw new Error(`codex queue exited with ${signal ?? code}`);
  },
  toolPrefix: 'mcp__agent_bridge__',
};
