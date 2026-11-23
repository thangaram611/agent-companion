"""Hand-run core qualification of the installed Copilot host, driven through its native tools (no model choosing calls).
Needs the private GPU Ollama on 127.0.0.1:11435 (see README). Usage: python3 probes/copilot-host/core.py
Steps: install twice (product.py); open the TUI (root A); send a Copilot job natively; the result wakes A and A answers;
read; follow up on the thread; cancel a long job; /new (root B): B lists nothing and cannot read A's thread; a busy wake
reaches B mid-call; the real Copilot companion jobs started no nested bridge."""
import glob
import json
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
TUI = HERE / 'tui.py'
TOKEN = 'COPILOT-TOKEN-' + str(int(time.time()))[-5:]


def log(*parts):
    print(f'[{time.strftime("%H:%M:%S")}]', *parts, flush=True)


out = subprocess.run([sys.executable, HERE / 'product.py'], capture_output=True, text=True, check=True).stdout
root = Path(re.search(r'Probe directory: (\S+)', out)[1])
log('installed', ' / '.join(l for l in out.splitlines() if l.startswith('Setup')), 'root', root)
profile, workspace = root / 'copilot_home', root / 'workspace'
records = profile / 'agent-companion'


def check(*args, timeout=1400):
    r = subprocess.run([sys.executable, HERE / 'check.py', root, *map(str, args)], capture_output=True, text=True, timeout=timeout)
    return (r.stdout + r.stderr).strip()


def call(sid, tool, args):
    # The control extension returns Copilot's tool envelope; the bridge's answer is its sessionLog.
    text = check('call', sid, 'agent-bridge-companion_' + tool, json.dumps(args))
    try:
        outer = json.loads(text)
    except ValueError:
        return text
    inner = outer.get('sessionLog') or ((outer.get('contents') or [{}])[0]).get('text', '')
    try:
        return json.loads(inner)
    except ValueError:
        return inner


def roots():
    return [line.split()[0] for line in check('sessions').splitlines() if 'control joined' in line]


def wait(predicate, seconds, label):
    end = time.time() + seconds
    while time.time() < end:
        value = predicate()
        if value:
            return value
        time.sleep(2)
    raise SystemExit(f'FAIL: no {label} within {seconds}s')


def events(sid):
    files = glob.glob(str(profile / '**' / sid / 'events.jsonl'), recursive=True)
    rows = []
    for f in files:
        for line in Path(f).read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    return rows


def said(sid, text, after=0):
    blob = json.dumps(events(sid)[after:])
    return text in blob


def result(job_id):
    path = records / 'results' / f'{job_id}.json'
    return json.loads(path.read_text()) if path.exists() else None


def starts():
    path = records / 'runtime/agent-bridge.log'
    return path.read_text().count('bridge.startup') if path.exists() else 0


# Root A in the TUI.
tui_run = root / 'tui'
tui_run.mkdir()
(tui_run / 'command.json').write_text(json.dumps({'executable': str(root / 'run'), 'cwd': str(workspace), 'wallSec': 3600,
    'env': {'PATH': '/usr/bin:/bin'}, 'args': ['copilot', '--disable-builtin-mcps', '--sync-session=off', '--allow-tool=agent-bridge', '--allow-tool=probe-control']}))
tui = subprocess.Popen([sys.executable, TUI, tui_run])


def type_(text):
    with open(tui_run / 'tui-input.jsonl', 'a') as f:
        f.write(json.dumps({'text': text}) + '\n')


try:
    for _ in range(6):  # folder trust and any first-run prompt take Enter
        time.sleep(5)
        if roots():
            break
        type_('\r')
    A = wait(lambda: (roots() or [None])[0], 120, 'root A registration')
    log('root A', A)
    bridges = starts()

    sent = call(A, 'send', {'companion': 'copilot', 'cwd': str(workspace), 'task': f'Reply with exactly: {TOKEN}'})
    log('send', json.dumps({k: sent.get(k) for k in ('status', 'thread', 'job_id', 'delivery')}) if isinstance(sent, dict) else sent)
    thread, job = sent['thread'], sent['job_id']
    mark = len(events(A))
    res = wait(lambda: result(job), 600, 'job result')
    log('job', res['outcome'], 'token in answer', TOKEN in (res.get('text') or ''))
    wait(lambda: said(A, 'agent-companion:', mark), 120, 'wake user.message in A')
    log('wake reached A as a user message')
    wait(lambda: said(A, 'assistant.message', mark) or said(A, '"assistant"', mark), 300, 'lead turn after the wake')
    log('lead answered after the wake')
    page = call(A, 'read', {'thread': thread})
    log('read has token', TOKEN in json.dumps(page))

    follow = call(A, 'send', {'thread': thread, 'task': 'What exact text did you reply with last time? Reply with just that text.'})
    res2 = wait(lambda: result(follow['job_id']), 600, 'follow-up result')
    log('follow-up', res2['outcome'], 'same thread', follow.get('thread') == thread, 'recalled token', TOKEN in (res2.get('text') or ''))

    long = call(A, 'send', {'companion': 'copilot', 'cwd': str(workspace), 'task': 'Run the shell command `sleep 120`, then reply DONE.'})
    time.sleep(20)
    cancelled = call(A, 'cancel', {'thread': long['thread']})
    log('cancel', json.dumps(cancelled)[:200] if not isinstance(cancelled, dict) else cancelled.get('status'))

    log('nested bridges during real Copilot jobs:', starts() - bridges,
        '| marked companion launches:', len((root / 'companion-starts').read_text().splitlines()) if (root / 'companion-starts').exists() else 0)

    # Root B.
    type_('/new\r')
    B = wait(lambda: next((s for s in roots() if s != A), None), 120, 'root B registration')
    listing = call(B, 'status', {})
    foreign = call(B, 'read', {'thread': thread})
    log('root B', B, '| B lists', len(listing.get('threads', [])) if isinstance(listing, dict) else listing,
        '| B reads A thread ->', foreign.get('code') if isinstance(foreign, dict) else str(foreign)[:120])

    # Busy wake on B: a 16 s fixture call outstanding, then a wake.
    (root / 'delay').write_text('16')
    mark = len(events(B))
    busy = subprocess.Popen([sys.executable, HERE / 'check.py', root, 'call', B, 'probe-control-companion_probe', '{}'],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(5)
    t0 = time.time()
    log('busy wake:', check('wake', B, 'Reply BUSY-481.'), f'({time.time() - t0:.1f}s)')
    log('fixture call returned:', (busy.communicate(timeout=120)[0] or '').strip()[:120])
    wait(lambda: said(B, 'BUSY-481', mark), 300, 'BUSY-481 in B')
    log('B received the busy wake; A untouched by it:', not said(A, 'BUSY-481'))
    log('PASS core steps')
finally:
    (tui_run / 'stop').write_text('')
    time.sleep(2)
    tui.kill()
    log('root kept for inspection:', root)
