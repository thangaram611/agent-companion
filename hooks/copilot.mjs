import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { copilot, stampLead, hookIdentity } from '../lib/hosts/copilot.mjs';
import { runtimeRoot } from '../lib/hosts/runtime.mjs';

if (process.env.AGENT_COMPANION_JOB !== undefined) process.exit(0);
const event = process.argv[2];
const data = JSON.parse(readFileSync(0, 'utf8'));
if (event === 'preToolUse') {
  if (!/^agent-bridge-companion_(send|status|wait|read|cancel)$/.test(data.toolName)) process.exit(0);
  const args = typeof data.toolArgs === 'string' ? JSON.parse(data.toolArgs) : data.toolArgs;
  console.log(JSON.stringify({ modifiedArgs: { ...args, lead: stampLead(data, process.env) } }));
} else {
  const identity = hookIdentity(data);
  if (!identity) process.exit(0);
  const news = join(runtimeRoot(copilot, process.env), 'news');
  if (!existsSync(identity.agent ? news : join(news, identity.session))) process.exit(0);
  const { Records } = await import('../bridge-server/controller/records.mjs');
  const { hookAnswer } = await import('../bridge-server/delivery.mjs');
  const records = new Records();
  // Nested agents report their immediate parent. Their own unique agent ID
  // finds the already bound root without treating that parent as the root.
  const lead = identity.agent ? records.listThreads().find(t =>
    t.lead?.host === copilot.id && t.lead.agent === identity.agent)?.lead : { host: copilot.id, ...identity };
  if (lead) {
    const additionalContext = hookAnswer(records, lead);
    if (additionalContext) console.log(JSON.stringify({ additionalContext }));
  }
}
