"""Run inside a prepared temp home, with a local plugin installed. No model prompt."""
import json
import select
import subprocess
import sys
import time
from pathlib import Path

root = Path(sys.argv[1]).resolve()
if not (root / 'package/run-dir').is_file() or (root / 'package/run-dir').read_text() != str(root):
    raise SystemExit('expected a fresh prepare.py directory')
args = [root / 'run', 'env', 'AGENT_COMPANION_JOB=fixture-job', 'copilot', '--acp',
        '--no-ask-user', '--allow-all-tools', '--allow-all-paths', '--allow-all-urls', *sys.argv[2:]]
with (root / 'acp-stderr').open('ab') as err:
    child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, bufsize=0)
    try:
        for i, (method, params) in enumerate([
            ('initialize', {'protocolVersion': 1, 'clientCapabilities': {}}),
            ('session/new', {'cwd': str(root / 'workspace'), 'mcpServers': []})
        ], 1):
            child.stdin.write((json.dumps(dict(jsonrpc='2.0', id=i, method=method, params=params)) + '\n').encode())
            deadline = time.monotonic() + 40
            while True:
                if not select.select([child.stdout], [], [], max(0, deadline-time.monotonic()))[0]:
                    raise TimeoutError(method)
                line = child.stdout.readline()
                if not line:
                    raise RuntimeError('ACP closed')
                msg = json.loads(line)
                if msg.get('id') == i:
                    if 'error' in msg:
                        raise RuntimeError(msg['error']['code'])
                    print(method, 'ok', msg['result'].get('sessionId', ''))
                    break
        time.sleep(2)
    finally:
        child.stdin.close()
        try:
            child.wait(timeout=6)
        except subprocess.TimeoutExpired:
            child.terminate()
            child.wait(timeout=6)
