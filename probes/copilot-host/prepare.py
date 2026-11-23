"""Print a new disposable probe directory. Use its 'run' launcher for every CLI."""
import json
import os
from pathlib import Path
import shlex
import shutil
import tempfile

src = Path(__file__).resolve().parent
root = Path(tempfile.mkdtemp(prefix="copilot-host-")).resolve()
plugin = root / "package"
extension = plugin / "extensions" / "notice"
extension.mkdir(parents=True)
for path, target in [(plugin, 'fixture.mjs'), (extension, 'extension.mjs')]:
    shutil.copyfile(src / target, path / target)
    (path / 'run-dir').write_text(str(root))
(plugin / 'agents').mkdir()
(plugin / 'agents/fixture-reader.agent.md').write_text(
    '---\nname: fixture-reader\ndescription: Read the synthetic token with the fixture tool.\n'
    'tools: ["agent-bridge/*"]\n---\nCall companion_probe exactly once. Return its result.')
node = shutil.which('node')
if not node:
    raise SystemExit('node required')
manifest = {'name': 'host-fixture', 'version': '1.0.0', 'extensions': ['./extensions'],
            'hooks': './hooks.json', 'mcpServers': {'agent-bridge': {
                'type': 'local', 'command': node, 'args': ['${PLUGIN_ROOT}/fixture.mjs'], 'tools': ['*']}}}
(plugin / 'plugin.json').write_text(json.dumps(manifest))
hook = plugin / 'hook.py'
shutil.copyfile(src / 'hook.py', hook)
events = ('sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'permissionRequest', 'sessionEnd')
(plugin / 'hooks.json').write_text(json.dumps({'version': 1, 'hooks': {
    k: [{'type': 'command', 'bash': 'python3 "${PLUGIN_ROOT}/hook.py" ' + k}] for k in events
}}))
env = {'PATH': os.environ['PATH'], 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
       'COPILOT_PROVIDER_BASE_URL': 'http://127.0.0.1:11435/v1', 'COPILOT_PROVIDER_TYPE': 'openai',
       'COPILOT_MODEL': 'gpt-oss:20b', 'COPILOT_OFFLINE': 'true', 'COPILOT_AUTO_UPDATE': 'false'}
for key in ('HOME', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
            'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR'):
    path = root / key.lower()
    path.mkdir(mode=0o700)
    env[key] = str(path)
workspace = root / 'workspace'
workspace.mkdir()
launcher = root / 'run'
launcher.write_text('#!/bin/sh\ncd ' + shlex.quote(str(workspace)) + ' || exit 1\nexec env -i ' +
                    ' '.join(shlex.quote(k + '=' + v) for k, v in env.items()) + ' "$@"\n')
launcher.chmod(0o700)
print(root)
