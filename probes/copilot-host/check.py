"""Run via python3 check.py <product.py directory> sessions|recursion|call|wake ..."""
import json
from pathlib import Path
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
if not (root / 'checkout').is_dir() or (root / 'package/run-dir').read_text() != str(root):
    sys.exit('Expected the temporary directory printed by product.py')
profile = root / 'copilot_home'
runtime = profile / 'agent-companion/runtime'
def sessions():
    return {json.loads(f.read_text())['session'] for f in (runtime / 'notices').glob('*.json')}
def starts():
    return (runtime / 'agent-bridge.log').read_text().count('bridge.startup') if (runtime / 'agent-bridge.log').exists() else 0
def events():
    return [json.loads(line) for line in (root / 'events').read_text().splitlines()] if (root / 'events').exists() else []
action = sys.argv[2]
if action == 'sessions':
    for sid in sorted(sessions()):
        print(sid, 'control joined' if (profile / f'probe-{sid}.ready').exists() else 'product only')
elif action == 'tools':
    # Use the installed manifest launcher with empty probe records. The
    # stdio client supplies no native pre-tool hook or Copilot call metadata.
    code = """import {spawn} from 'node:child_process';
import {join} from 'node:path';
const {startBridge} = await import(process.argv[1]);
const root = process.argv[2];
const bridge = await startBridge('probe', {repo: root, spawnProcess: (_node, _args, opts) =>
  spawn('/bin/bash', [join(root, 'hooks/launch-agent-bridge.sh')], opts)});
try {
  const {tools} = await bridge.rpc('tools/list', {});
  const names = tools.map(tool => tool.name).sort().join(',');
  const expected = ['cancel','catalog','read','send','status','wait'].map(action => 'companion_' + action).join(',');
  if (names !== expected) throw Error(names);
  for (const args of [{}, {lead: {session:'probe', agent:null}}]) {
    const reply = await bridge.rpc('tools/call', {name:'companion_status', arguments:args});
    if (JSON.parse(reply.content[0].text).code !== 'LEAD_REQUIRED') throw Error('Direct identity accepted');
  }
  console.log(names + '; both direct thread calls refused');
} finally {await bridge.stop();}"""
    subprocess.run([root / 'run', 'env', 'AGENT_COMPANION_HOST=copilot', 'COPILOT_AGENT_SESSION_ID=probe',
        'AGENT_COMPANION_HOME=' + str(root / 'direct-records'), 'AGENT_RUNTIME_DIR=' + str(root / 'direct-runtime'),
        'node', '--input-type=module', '-e', code, (root / 'checkout/probes/smoke/bridge-client.mjs').as_uri(),
        root / 'checkout'], check=True)
elif action == 'recursion':
    before, joins, rows = starts(), sessions(), len(events())
    subprocess.run([sys.executable, Path(__file__).with_name('acp.py'), root, '--disable-mcp-server', 'agent-bridge'], check=True)
    assert starts() == before and sessions() == joins
    assert any(e.get('marked') and e['event'] == 'start' for e in events()[rows:])
    print('No additional bridge startup or registration. The unrelated MCP started with the job marker.')
else:
    sid = sys.argv[3]
    if sid not in sessions():
        sys.exit('No product registration for that session')
    if action == 'call':
        name, args = sys.argv[4], json.loads(sys.argv[5])
        base = profile / f'probe-{sid}'
        if not base.with_suffix('.ready').is_file():
            sys.exit('No control extension for that session')
        result = base.with_suffix('.result')
        result.unlink(missing_ok=True)
        staged = base.with_suffix('.tmp')
        staged.write_text(json.dumps({'name': name, 'arguments': args}))
        staged.rename(base.with_suffix('.call'))
        # One outstanding control per session. Open a second terminal for a mid-call wake.
        for _ in range(13210):
            if result.is_file():
                print(result.read_text())
                break
            time.sleep(.1)
        else:
            sys.exit('No native tool result within 1321 seconds')
    elif action == 'wake':
        module = (root / 'checkout/lib/hosts/copilot.mjs').as_uri()
        code = """const {copilot} = await import(process.argv[1]);
const lead = {host: copilot.id, session: process.env.COPILOT_AGENT_SESSION_ID, agent: null};
if (!(await copilot.wakeStatus(lead, process.env)).wake) throw Error('No live receiver');
await copilot.wake(lead, process.argv[2], process.env);"""
        subprocess.run([root / 'run', 'env', 'COPILOT_AGENT_SESSION_ID=' + sid, 'node',
                        '--input-type=module', '-e', code, module, sys.argv[4]], check=True)
        print('session.send acknowledged; inspect user.message in the addressed transcript')
    else:
        sys.exit('Expected sessions, recursion, call or wake')
