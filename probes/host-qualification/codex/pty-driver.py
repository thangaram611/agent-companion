#!/usr/bin/env python3
"""POSIX PTY only. No screen parsing or assertion that a submitted slash command ran."""
import errno
import json
import os
import pathlib
import pty
import select
import signal
import sys
import termios
import time
import tty

run = pathlib.Path(sys.argv[1])
argv = json.loads((run / 'command.json').read_text())['argv']
gate_read, gate_write = os.pipe()
pid, master = pty.fork()
if pid == 0:
    os.close(gate_write)
    if os.read(gate_read, 1) != b'g':
        os._exit(1)
    os.close(gate_read)
    os.chdir(json.loads((run / 'manifest.json').read_text())['paths']['workspace'])
    os.execvpe(argv[0], argv, os.environ)
os.close(gate_read)
(run / 'pty-host.tmp').write_text(json.dumps({'pid': pid}))
(run / 'pty-host.tmp').replace(run / 'pty-host.json')
saved = termios.tcgetattr(0) if os.isatty(0) else None
def terminate(signum, _frame):
    raise SystemExit(128 + signum)
signal.signal(signal.SIGTERM, terminate)
queue_offset = 0
stdin_open = True

def emit(kind, **fields):
    with (run / 'pty-events.jsonl').open('a') as target:
        target.write(json.dumps({'time': time.time() * 1000, 'mono_ms': time.monotonic_ns() / 1e6,
                                 'type': kind, **fields}) + '\n')

try:
    while not (run / 'pty-host-registered').exists():
        time.sleep(0.05)
    os.write(gate_write, b'g')
    os.close(gate_write)
    if saved:
        tty.setraw(0)
        # Mirror terminal dimensions; the operator's terminal answers device queries.
        import fcntl
        import struct
        def resize(*_):
            size = os.get_terminal_size(0)
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', size.lines, size.columns, 0, 0))
        signal.signal(signal.SIGWINCH, resize)
        resize()
    with (run / 'pty-output.bin').open('ab') as capture:
        while True:
            readable, _, _ = select.select([master] + ([0] if stdin_open else []), [], [], 0.1)
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                capture.write(data)
                capture.flush()
                os.write(1, data)
            if stdin_open and 0 in readable:
                data = os.read(0, 4096)
                if data:
                    emit('operator_keys', hex=data.hex())
                    os.write(master, data)
                else:
                    stdin_open = False
            queue = run / 'pty-input.jsonl'
            if queue.exists():
                with queue.open() as source:
                    source.seek(queue_offset)
                    for line in source:
                        if not line.endswith('\n'):
                            break
                        item = json.loads(line)
                        data = item['text'].encode()
                        # Paste text as a unit; trailing CR executes after bracketed paste ends.
                        if len(data) > 200 and data.endswith(b'\r'):
                            data = b'\x1b[200~' + data[:-1] + b'\x1b[201~\r'
                        os.write(master, data)
                        emit('pty_input_delivered', action=item['action'], queued_time=item['time'])
                        queue_offset += len(line.encode())
    _, status = os.waitpid(pid, 0)
    emit('pty_host_exit', status=status)
finally:
    if saved:
        termios.tcsetattr(0, termios.TCSADRAIN, saved)
    os.close(master)
