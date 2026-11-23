"""Hand-run OpenCode host qualification. All CLI calls inherit the isolated environment."""
import json
import os
from pathlib import Path
import random
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
# OPENCODE_PROBE_OLLAMA=<base URL ending in /v1> runs lead and companion on a local Ollama (gpt-oss:20b, 32k context);
# the free OpenCode model refuses the lead's tool-laden prompts with provider.free-limit.
OLLAMA = os.environ.get("OPENCODE_PROBE_OLLAMA")
IDLE = os.environ.get("OPENCODE_PROBE_IDLE", "1 minute")
MODEL = "ollama/gpt-oss:20b" if OLLAMA else "opencode/flint-40b-free"
PROVIDER = {"ollama": {"npm": "@ai-sdk/openai-compatible", "name": "Ollama (probe)", "options": {"baseURL": OLLAMA},
                       "models": {"gpt-oss:20b": {"name": "gpt-oss 20b", "tool_call": True}}}} if OLLAMA else None
TOOLS = {"companion_" + action for action in ("catalog", "send", "read", "wait", "status", "cancel")}


def wait_for(check, seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(1)
    raise RuntimeError(f"timed out waiting for {check.__name__} after {seconds}s")


def copy_checkout(src, dst):
    """Copy tracked and unignored files: ignored run folders hold runtime state and dangling links."""
    names = subprocess.run(["git", "-C", str(src), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           capture_output=True, check=True).stdout.decode().split("\0")
    for name in names:
        if name and os.path.lexists(src / name):
            (dst / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / name, dst / name, follow_symlinks=False)


class ProviderUnavailable(RuntimeError):
    pass


def qualify(base):
    home, work, checkout = (base / name for name in ("home", "work", "checkout"))
    home.mkdir()
    work.mkdir()
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(base / "tmp")}
    Path(env["TMPDIR"]).mkdir()
    for name in ("config", "data", "state", "cache"):
        env[f"XDG_{name.upper()}_HOME"] = str(base / name)
    config = base / "config/opencode"
    records = config / "agent-companion"
    db = base / "data/opencode/opencode.db"
    # Count actual launches, including a short-lived nested bridge between observations.
    trace = base / "bridges"
    preload = base / "count.cjs"
    preload.write_text("if (process.argv[1]?.endsWith('/bridge-server/server.mjs')) " +
                       "require('node:fs').appendFileSync(" + json.dumps(str(trace)) +
                       ", JSON.stringify({pid:process.pid,ppid:process.ppid,cwd:process.cwd()})+'\\n');")
    env["NODE_OPTIONS"] = "--require " + json.dumps(str(preload))

    def run(*argv, timeout=60, check=True, cwd=work):
        result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"{argv[0:3]} exited {result.returncode}: {(result.stderr or result.stdout)[-800:]}")
        return result

    def api(method, path, body=None):
        args = ["opencode", "api", method, path]
        if body is not None:
            args += ["--data", json.dumps(body)]
        output = run(*args, timeout=15).stdout.strip()
        return json.loads(output) if output else None

    def starts():
        return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []

    def messages(session):
        # Reading the isolated DB does not reset the location's idle timer.
        # 2.4.0 keeps a message's parts in session_part and leaves `content` empty.
        with sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True) as connection:
            rows = connection.execute("SELECT id,type,data FROM session_message WHERE session_id=? ORDER BY seq", (session,)).fetchall()
            parts = {}
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_part'").fetchone():
                for message, data in connection.execute(
                        "SELECT message_id,data FROM session_part WHERE session_id=? ORDER BY message_id,ordinal", (session,)):
                    parts.setdefault(message, []).append(json.loads(data))
        return [(role, {**json.loads(data), **({"content": parts[mid]} if mid in parts else {})}) for mid, role, data in rows]

    def scenario(long_job):
        task = ("Use the shell to run sleep 170 in the foreground. After it exits reply OC-LONG."
                if long_job else "Reply OC-SHORT.")
        provider_id, _, model_id = MODEL.partition("/")
        model = {"providerID": provider_id, "id": model_id}
        # Without companion_wait the lead must end its turn, so the result arrives through the wake.
        permissions = [{"action": "*", "resource": "*", "effect": "deny"}] + [
            {"action": "agent-bridge_companion_" + tool, "resource": "*", "effect": "allow"} for tool in ("send", "read")]
        session = api("POST", "/api/session", {"location": {"directory": str(work)}, "model": model,
                                              "permissions": permissions})["data"]["id"]
        prompt = (f"Copy the exact six tool names beginning with agent-bridge_companion_ from your "
                  f"function list. Use only those direct functions throughout this probe. Call the exposed function agent-bridge_companion_send directly, once, "
                  f"with exactly these four arguments and no others: companion opencode, model {MODEL}, cwd {work} and task {json.dumps(task)}. "
                  "End your turn immediately after send. On the completion notice call "
                  "agent-bridge_companion_read and quote the returned answer.")
        api("POST", f"/api/session/{session}/prompt", {"text": prompt})
        def terminal():
            for path in records.glob("threads/*.json"):
                thread = json.loads(path.read_text())
                if thread["lead"]["session"] == session:
                    result = records / "results" / (thread["jobId"] + ".json")
                    if result.exists():
                        return json.loads(result.read_text())
            for role, msg in messages(session):
                if role == "idle" and msg.get("outcome") == "failed":
                    raise ProviderUnavailable(msg.get("error", {}).get("type", "lead turn failed"))
        def dump():
            # What the lead did, and what the bridge logged, so a failed run can be read after the temp home is gone.
            for role, m in messages(session)[-12:]:
                parts = [(p.get("type"), p.get("name"), (p.get("text") or json.dumps(p.get("state", {}).get("output", ""))[:160])[:160])
                         for p in m.get("content", [])] if isinstance(m.get("content"), list) else (m.get("text") or "")[:200]
                print(f"  lead {role}: {json.dumps(parts)[:400]}", flush=True)
            log = records / "runtime" / "agent-bridge.log"
            if log.exists():
                print("  bridge log tail: " + " | ".join(log.read_text().splitlines()[-8:])[:1500], flush=True)
        try:
            result = wait_for(terminal, 340 if long_job else 120)
        except RuntimeError:
            api("POST", f"/api/session/{session}/interrupt", {})
            dump()
            raise
        job = json.loads((records / "jobs" / (result["jobId"] + ".json")).read_text())
        print(f"  {'long' if long_job else 'short'} job {result['outcome']} after {(result['finishedAt'] - job['startedAt']) / 1000:.1f} s", flush=True)
        if result["outcome"] != "completed":
            print(f"  job {result['outcome']}: {json.dumps({k: result.get(k) for k in ('cause', 'detail', 'error')})} text={json.dumps((result.get('text') or '')[:600])}", flush=True)
        def reply():
            turns = messages(session)
            notice = next((i for i, (role, m) in enumerate(turns) if role == "user"
                           and m.get("text", "").startswith("agent-companion:") and result["jobId"] in m["text"]), None)
            if notice is None:
                return
            parts = [p for role, m in turns[notice+1:] if role == "assistant" for p in m.get("content", [])]
            for index, part in enumerate(parts):
                if (part.get("name") == "agent-bridge_companion_read"
                        and part.get("state", {}).get("status") == "completed"):
                    answers = [p["text"] for p in parts[index+1:] if p["type"] == "text"]
                    if answers:
                        return answers
        try:
            response = wait_for(reply, 100)
        except RuntimeError:
            dump()
            raise
        rendered = "\n".join(m.get("text", "") + "\n".join(p.get("text", "") for p in m.get("content", [])
                             if p["type"] == "text") for role, m in messages(session) if role == "assistant")
        listed = sum("agent-bridge_" + tool in rendered for tool in TOOLS)
        launched = starts()[before_service:]
        lead_bridges = [s for s in launched if s["ppid"] == service_pid and s["cwd"] == str(work)]
        nested = [s for s in launched if s["ppid"] != service_pid]
        turns = messages(session)
        wake_time = next(m["time"]["created"] for role, m in turns if role == "user"
                         and m.get("text", "").startswith("agent-companion:") and result["jobId"] in m["text"])
        idle_time = next((m["time"]["created"] for role, m in turns if role == "idle"
                          and job["startedAt"] <= m["time"]["created"] < wake_time), wake_time)
        idle_seconds = (wake_time - idle_time) / 1000
        elapsed = (result["finishedAt"] - job["startedAt"]) / 1000
        print(f"session listed={listed}/6 outcome={result['outcome']} wake=true read=true "
              f"job_seconds={elapsed:.1f} idle_before_wake_seconds={idle_seconds:.1f} lead_bridge_starts={len(lead_bridges)} nested_bridge_starts={len(nested)} "
              f"cleanup={result.get('stopEvidence', {}).get('error', 'ok')}", flush=True)
        token = "OC-LONG" if long_job else "OC-SHORT"
        dashes = lambda text: text.replace("\u2011", "-")  # small models write a non-breaking hyphen
        return (listed == 6 and result["outcome"] == "completed" and token in dashes(result["text"])
                and token in dashes(" ".join(response)) and lead_bridges and not nested
                and (not long_job or (elapsed >= 170 and idle_seconds > 60)))

    port = str(random.SystemRandom().randrange(41000, 49000))
    run("opencode", "service", "set", "port", port)
    try:
        copy_checkout(ROOT, checkout)
        (config / "opencode.json").write_text(json.dumps({"model": MODEL, **({"provider": PROVIDER} if PROVIDER else {})}))
        # OPENCODE_PROBE_IDLE goes through setup's own option: "1 minute" (default) checks the idle unload;
        # "false" (the decided install) checks that a long job survives an idle lead.
        for _ in range(2):
            run("bash", str(checkout / "setup.sh"), "--host", "opencode", "--companion", "none", "--opencode-idle-timeout", IDLE,
                "--skip-tests", "--yes", timeout=300)
        doctor = json.loads(run("node", str(checkout / "scripts/doctor.mjs"), "--json", check=False, timeout=180).stdout)
        assert doctor["opencode"]["installed"]
        before_service = len(starts())
        run("opencode", "service", "start")
        service_pid = json.loads((base / "state/opencode/service.json").read_text())["pid"]
        where = "?location[directory]=" + quote(str(work), safe="")
        def connected():
            return any(s["name"] == "agent-bridge" and s["status"]["status"] == "connected"
                       for s in api("GET", "/api/mcp" + where)["data"])
        wait_for(connected, 60)
        plugins = [p for p in api("GET", "/api/plugin" + where)["data"] if p["id"] == "agent-companion"]
        assert len(plugins) == 1 and plugins[0]["state"]["status"] == "active"
        print("setup_runs=2 doctor_marker=true active_plugin_entries=1 mcp=connected port=" + port, flush=True)
        success = True
        for long_job in [x for x in (False, True) if os.environ.get("OPENCODE_PROBE_SCENARIOS", "short,long").count("long" if x else "short")]:
            try:
                success = scenario(long_job) and success
            except ProviderUnavailable as exc:
                print(f"lead unavailable: {exc}", flush=True)
                success = False
                break
            except (RuntimeError, subprocess.TimeoutExpired) as exc:
                print(f"job check failed: {exc}", flush=True)
                success = False
        if IDLE == "false":
            return success
        # A location sweep runs about once per minute. Poll only the observed
        # bridge PID until it exits, then inspect the location from a different cwd.
        pid = next(s["pid"] for s in reversed(starts()[before_service:]) if s["cwd"] == str(work))
        def unloaded():
            try:
                os.kill(pid, 0)
                return False
            except ProcessLookupError:
                return True
        wait_for(unloaded, 190)
        locations = json.loads(run("opencode", "api", "GET", "/api/debug/location", cwd=home).stdout)
        assert str(work) not in [row["directory"] for row in locations]
        print("idle_bridge_gone=true idle_location_loaded=false", flush=True)
        return success
    finally:
        run("opencode", "service", "stop")
        status = run("opencode", "service", "status").stdout.strip()
        print("isolated service status=" + status, flush=True)
        if status != "stopped":
            raise RuntimeError("isolated service still running")


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    with tempfile.TemporaryDirectory(prefix="ac-oc-host-") as tmp:
        sys.exit(0 if qualify(Path(tmp).resolve()) else 1)
