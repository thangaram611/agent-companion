import { dispatch } from '../bridge-server/tools.mjs';

export const testLead = { host: 'claude', session: 'test-session', agent: null };
export function decodeTool({ content }) {
  if (content.length === 1) return JSON.parse(content[0].text);
  return { ...JSON.parse(content[1].text), content: content[0].text };
}

export async function callTool({ action, ...args }, options) {
  const { session, agent } = testLead;
  return decodeTool(await dispatch({ name: 'companion_' + action, arguments: { lead: { session, agent }, ...args } },
    { host: 'claude', ...options }));
}
