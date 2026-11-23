import { fileURLToPath } from 'node:url';

export default {
  id: 'agent-companion',
  async setup(ctx) {
    if (process.env.AGENT_COMPANION_JOB !== undefined) return;
    await ctx.mcp.transform(editor => editor.set('agent-bridge', {
      type: 'local',
      codemode: false,
      command: ['/bin/bash', fileURLToPath(new URL('../hooks/launch-agent-bridge.sh', import.meta.url))],
      cwd: ctx.location.directory,
      environment: { AGENT_COMPANION_HOST: 'opencode' },
      timeout: { startup: 120000, execution: 1320000 },
    }));
  },
};
