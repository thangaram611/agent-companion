"""Install the working tree twice in a disposable Copilot profile. Print its launcher."""
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

src = Path(__file__).resolve().parents[2]
root = Path(subprocess.check_output([sys.executable, src / 'probes/copilot-host/prepare.py'], text=True).strip())
checkout = root / 'checkout'
print(f'Probe directory: {root}', flush=True)
shutil.copytree(src, checkout, ignore=shutil.ignore_patterns('.git', 'node_modules', '.plugin-data', 'dist', '__pycache__'))
run = str(root / 'run')
def command(*argv):
    return subprocess.check_output([run, *map(str, argv)], text=True)

# Copilot filters the provider environment before launching MCP. Pin the local
# backend on the disposable bridge and record actual marked companion launches.
binary = shutil.which('copilot')
wrapper = root / 'companion'
wrapper.write_text('#!/bin/sh\nset -eu\n' +
    'test "$COPILOT_HOME" = ' + shlex.quote(str(root / 'copilot_home')) + '\n' +
    'test "$COPILOT_OFFLINE" = true\ntest "$COPILOT_PROVIDER_BASE_URL" = http://127.0.0.1:11435/v1\n' +
    'if [ "${1:-}" = --acp ]; then echo "${AGENT_COMPANION_JOB:?} $*" >> ' + shlex.quote(str(root / 'companion-starts')) + '; fi\n' +
    'exec ' + shlex.quote(binary) + ' "$@"\n')
wrapper.chmod(0o700)
manifest = checkout / '.github/plugin/plugin.json'
spec = json.loads(manifest.read_text())
spec['mcpServers']['agent-bridge']['env'].update(
    COPILOT_PROVIDER_BASE_URL='http://127.0.0.1:11435/v1', COPILOT_PROVIDER_TYPE='openai',
    COPILOT_MODEL='gpt-oss:20b', COPILOT_OFFLINE='true', COPILOT_BIN=str(wrapper))
manifest.write_text(json.dumps(spec))
# A second MCP server logs starts, allowing a positive recursion control.
config = root / 'copilot_home/mcp-config.json'
config.write_text(json.dumps({'mcpServers': {'probe-control': {'type': 'local', 'command': shutil.which('node'),
    'args': [str(root / 'package/fixture.mjs')], 'tools': ['*']}}}))
for i in range(2):
    output = command('/bin/bash', checkout / 'setup.sh', '--host', 'copilot', '--skip-tests', '--yes', '--companion', 'none')
    assert 'whole Copilot profile' in output
    markets = json.loads(command('copilot', 'plugin', 'marketplace', 'list', '--json'))
    assert len([m for m in markets if m['name'] == 'agent-companion' and m['source'] == 'Local: ' + str(checkout)]) == 1
    plugins = json.loads(command('copilot', 'plugin', 'list', '--json'))
    assert len([p for p in plugins if p['name'] == 'agent-companion' and p['enabled'] and p['installedFrom'] == str(checkout)]) == 1
    assert command('copilot', 'mcp', 'list').count('agent-bridge (local)') == 1
    assert json.loads((root / 'copilot_home/settings.json').read_text())['experimental'] is True
    print(f'Setup {i+1}: one local marketplace, enabled plugin and bridge; experimental saved.', flush=True)
# Only after checking the one-plugin installation, add an independent probe
# plugin with a native tool driver, a subagent and a post-tool context canary.
package = root / 'package'
(package / 'plugin.json').write_text(json.dumps({'name': 'product-control', 'version': '1.0.0',
    'extensions': ['./extensions'], 'hooks': './hooks.json'}))
(package / 'hooks.json').write_text(json.dumps({'version': 1, 'hooks': {'postToolUse': [{
    'type': 'command', 'bash': """echo '{"additionalContext":"PROBE-HOOK-673"}'"""}]}}))
shutil.copyfile(src / 'probes/copilot-host/product-control.mjs', package / 'extensions/notice/extension.mjs')
(package / 'agents/fixture-reader.agent.md').write_text(
    '---\nname: fixture-reader\ndescription: Delegate the synthetic task and wait for its result.\n'
    'tools: ["agent-bridge/*", "task"]\n---\nUse the bridge tools to carry out the requested qualification check.')
command('copilot', 'plugin', 'install', package)
print(f'{run} copilot --disable-builtin-mcps --sync-session=off --allow-tool=agent-bridge')
