"""Serve a private APFS clone of gpt-oss:20b on macOS. Stop with Ctrl-C."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cpu', action='store_true', help='for sandboxes without a Metal command queue')
options = parser.parse_args()
model_store = Path(os.environ.get('OLLAMA_MODELS', Path.home() / '.ollama/models'))
ollama = shutil.which('ollama')
if not ollama:
    raise SystemExit('ollama required')

with tempfile.TemporaryDirectory(prefix='copilot-host-ollama-') as temp:
    root = Path(temp)
    env = {'PATH': os.environ['PATH'], 'LANG': 'en_US.UTF-8'}
    for key in ('HOME', 'COPILOT_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
                'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR'):
        path = root / key.lower()
        path.mkdir(mode=0o700)
        env[key] = str(path)
    dest = root / 'models'
    manifest = Path('manifests/registry.ollama.ai/library/gpt-oss/20b')
    model = json.loads((model_store / manifest).read_text())
    for rel in [manifest, *(Path('blobs') / layer['digest'].replace(':', '-')
                            for layer in [model['config'], *model['layers']])]:
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['cp', '-c', model_store / rel, dest / rel], check=True)
    env['OLLAMA_HOST'] = '127.0.0.1:11434'
    while 'gpt-oss' in subprocess.check_output([ollama, 'ps'], env=env, text=True).lower():
        print('Waiting for gpt-oss to leave 11434', flush=True)
        time.sleep(10)
    with socket.socket() as check:
        check.bind(('127.0.0.1', 11435))
    env.update(OLLAMA_HOST='127.0.0.1:11435', OLLAMA_MODELS=str(dest),
               OLLAMA_CONTEXT_LENGTH='32768', OLLAMA_KEEP_ALIVE='2m', OLLAMA_NO_CLOUD='1')
    if options.cpu:
        env.update(LLAMA_ARG_DEVICE='none', LLAMA_ARG_KV_OFFLOAD='0')
    child = subprocess.Popen([ollama, 'serve'], cwd=root, env=env)
    try:
        child.wait()
    except KeyboardInterrupt:
        child.terminate()
        child.wait(timeout=15)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
    check = subprocess.run(['lsof', '-nP', '-iTCP:11435', '-sTCP:LISTEN'], env=env)
    if check.returncode != 1:
        raise SystemExit('11435 cleanup unverified')
    print('No listener on 11435.')
