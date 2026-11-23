"""Scripted PTY host for the direct-main probe. Standard library only.
Usage: python3 tui.py RUN_DIR   (reads RUN_DIR/command.json; input arrives through RUN_DIR/tui-input.jsonl)
Writes raw terminal bytes to RUN_DIR/terminal.log and exits when the child does or RUN_DIR/stop exists."""
import errno, fcntl, json, os, pathlib, pty, select, struct, sys, termios, time

run = pathlib.Path(sys.argv[1])
command = json.loads((run / "command.json").read_text())
pid, master = pty.fork()
if pid == 0:
    os.chdir(command["cwd"])
    os.execvpe(command["executable"], [command["executable"], *command["args"]], command["env"])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
(run / "host.json").write_text(json.dumps({"pid": pid, "started": int(time.time() * 1000)}))
offset, buffer = 0, b""
deadline = time.time() + command.get("wallSec", 600)
with (run / "terminal.log").open("ab") as log:
    while time.time() < deadline and not (run / "stop").exists():
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            log.write(data); log.flush()
        queue = run / "tui-input.jsonl"
        if queue.exists():
            with queue.open("rb") as handle:
                handle.seek(offset); chunk = handle.read(); offset += len(chunk)
            buffer += chunk
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                if line:
                    os.write(master, json.loads(line)["text"].encode())
                    with (run / "controller.jsonl").open("a") as handle:
                        handle.write(json.dumps({"t": int(time.time() * 1000), "sent": json.loads(line)["text"]}) + "\n")
try:
    os.kill(pid, 15)
    time.sleep(3)
    os.kill(pid, 9)
except OSError:
    pass
