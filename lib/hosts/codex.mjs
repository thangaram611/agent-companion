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
  toolPrefix: 'mcp__agent_bridge__',
};
