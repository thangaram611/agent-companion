import { homedir } from 'node:os';
import { join } from 'node:path';

export const claude = {
  id: 'claude',
  displayName: 'Claude Code',
  configDir: (env = process.env) => join(env.HOME || homedir(), '.claude'),
  pluginDataDir: (env, root) => env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || join(root, '.plugin-data'),
  settingsName: 'settings.json',
  leadFromCall({ args }) {
    const { session, agent = null } = args.lead ?? {};
    if (typeof session !== 'string' || !session.trim() || session.includes('${') || session.includes('}')) return null;
    if (agent !== null && (typeof agent !== 'string' || !agent.trim())) return null;
    return { host: this.id, session, agent };
  },
  toolPrefix: 'mcp__plugin_agent-companion_agent-bridge__',
};
