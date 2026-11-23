import { dispatch } from '../bridge-server/tools.mjs';

export const testLead = { host: 'claude', session: 'test-session', agent: null };
export function callTool({ action, ...args }, options) {
  const { session, agent } = testLead;
  return dispatch({ name: 'agent_' + action, arguments: { lead: { session, agent }, ...args } },
    { host: 'claude', ...options });
}
