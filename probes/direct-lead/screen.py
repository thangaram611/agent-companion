"""Print the tail of a terminal.log as text. Usage: python3 screen.py RUN_DIR [chars]"""
import pathlib, re, sys
raw = (pathlib.Path(sys.argv[1]) / "terminal.log").read_bytes().decode("utf-8", "replace")
tail = raw[-int(sys.argv[2]) if len(sys.argv) > 2 else -6000:]
text = re.sub(r"\x1b\[[0-9]*C", " ", tail)                       # cursor forward = a gap
text = re.sub(r"\x1b\[[0-9;]*[Hfd]|\x1b\[[0-9]*[ABEF]", "\n", text)  # cursor moves = a new line
text = re.sub(r"\x1b\[[0-9;?<>=]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\\\)|\x1b[()][A-Z0-9]|\x1b[=>]", "", text)
out = []
for line in text.replace("\r", "\n").split("\n"):
    line = line.rstrip()
    if line.strip() and (not out or out[-1] != line):
        out.append(line)
print("\n".join(out[-70:]))
