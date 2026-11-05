"""POSIX PTY adapter only. Standard library; runner creates a per-run venv."""
import errno
import fcntl
import json
import os
import pathlib
import pty
import select
import signal
import struct
import sys
import termios
import time
import tty

run = pathlib.Path(sys.argv[1])
command = json.loads((run / "command.json").read_text())
pid, master = pty.fork()
if pid == 0:
    os.chdir(command["cwd"])
    os.execvpe(command["executable"], [command["executable"], *command["args"]], os.environ)

host_file = run / "host.json.tmp"
host_file.write_text(json.dumps({"pid": pid, "started": int(time.time() * 1000)}))
os.replace(host_file, run / "host.json")
old = termios.tcgetattr(sys.stdin.fileno())
stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True  # Node owns PID-specific shutdown and verification.


def resize(_signum=None, _frame=None):
    try:
        size = fcntl.ioctl(sys.stdin.fileno(), termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
        fcntl.ioctl(master, termios.TIOCSWINSZ, size)
    except OSError:
        pass


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGWINCH, resize)
offset = 0
buffer = b""
status = None
try:
    tty.setraw(sys.stdin.fileno())
    resize()
    while not stopping:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 4096)
            if data:
                os.write(master, data)
        queue = run / "tui-input.jsonl"
        if queue.exists():
            with queue.open("rb") as handle:
                handle.seek(offset)
                chunk = handle.read()
                offset += len(chunk)
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if line:
                    item = json.loads(line)
                    os.write(master, item["text"].encode())
                    with (run / "controller.jsonl").open("a") as handle:
                        handle.write(json.dumps({"t": int(time.time() * 1000), "event": "pty_input_written",
                                                 "input_t": item["t"], "pid": os.getpid()}) + "\n")
        result, observed = os.waitpid(pid, os.WNOHANG)
        if result:
            status = observed
            break
finally:
    termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old)
    os.close(master)

if status is None and not stopping:
    _, status = os.waitpid(pid, 0)
(run / "pty-exit.json").write_text(json.dumps({"t": int(time.time() * 1000), "status": status, "stopping": stopping}))
sys.exit(os.waitstatus_to_exitcode(status) if status is not None and not stopping else 1)
