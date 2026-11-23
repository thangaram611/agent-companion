import json
import os
from pathlib import Path
import sys
import time

root = Path(Path(__file__).with_name("run-dir").read_text())
data = json.load(sys.stdin)
event = sys.argv[1]
with (root / 'events').open('a') as out:
    print(json.dumps({'t': round(time.time() * 1000), 'pid': os.getpid(), 'event': event,
                      'session': data.get('sessionId'), 'keys': sorted(data),
                      'agent': data.get('agentId'), 'parent': data.get('parentAgentId'),
                      'envSession': os.environ.get('COPILOT_AGENT_SESSION_ID'),
                      'call': data.get('toolCallId'), 'tool': data.get('toolName')}), file=out)
result = {'additionalContext': 'The ' + event + ' canary is ' +
          {'sessionStart': 'LIME-131', 'userPromptSubmitted': 'PEAR-747',
           'postToolUse': 'PLUM-551'}.get(event, 'NONE')}
if event == 'preToolUse' and (root / 'pre-allow').exists() and 'companion_probe' in data.get('toolName', ''):
    result['permissionDecision'] = 'allow'
if event == 'preToolUse' and (root / 'stamp').exists() and data.get('toolName') == 'agent-bridge-companion_probe':
    args = data['toolArgs']
    if isinstance(args, str):
        args = json.loads(args)
    result['modifiedArgs'] = {**args, 'lead': 'host-hook'}
if event == 'permissionRequest' and (root / 'permission-allow').exists():
    # Isolated fixture home. Match only the synthetic server/tool in the permission payload.
    if data.get('toolName') == 'agent-bridge/companion_probe':
        result = {'behavior': 'allow'}
print(json.dumps(result))
