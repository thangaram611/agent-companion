#!/bin/bash
# Hour-long idle-then-wake checks for all five hosts, run side by side. Usage: long/run-all.sh [IDLE_SECONDS]
# Each host writes runs/long-<host>.result when done. Nothing here types into a host UI except Copilot's
# folder-trust prompt for the probe's own scratch folder.
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"; cd "$HERE" || exit 1
IDLE="${1:-3900}"; WALL=$((IDLE + 260))
nap() { perl -e 'select(undef,undef,undef,shift)' "$1"; }
until_file() { local i=0; until [ -e "$1" ] || [ $i -ge "$2" ]; do nap 2; i=$((i+1)); done; }
until_call() { local i=0; until grep -q '"event":"call"' "$1/fixture.jsonl" 2>/dev/null || [ $i -ge 40 ]; do nap 2; i=$((i+1)); done; }

claude_host() {
  node run.mjs long-claude --wall $WALL --seconds $((IDLE + 150)) --envhook 1 --postback $IDLE --prompt-file prompt-rewake.txt > runs/long-claude.out 2>&1
  { echo "claude: idle $IDLE s, then the bridge-like child posted to the inbox socket"; grep -h "result success\|postback\|closing" runs/long-claude.out "$(ls -d runs/long-claude-2026*/ | tail -1)fixture.jsonl" | cut -c1-200; } > runs/long-claude.result
}
codex_host() {
  local RUN; RUN=$(node codex/prepare.mjs long-codex); node codex/tui.mjs "$RUN" 'PROBE-CALL job_send {"task":"probe"}' $WALL; until_call "$RUN"
  local TID; TID=$(node -e 'const fs=require("fs");const l=fs.readFileSync(process.argv[1]+"/fixture.jsonl","utf8").trim().split("\n").map(JSON.parse).find(r=>r.event==="call");console.log(l?l.meta.threadId:"")' "$RUN")
  nap $IDLE
  local OUT; OUT=$(cd "$RUN/workspace" && env -i PATH="$PATH" HOME="$RUN/home" CODEX_HOME="$RUN/codex-home" TMPDIR="$RUN/tmp" LANG=en_US.UTF-8 perl -e 'alarm 60; exec @ARGV' codex queue --thread "$TID" --message "PROBE-WAKE after an idle hour" < /dev/null 2>&1 | tail -1)
  nap 40
  { echo "codex: idle $IDLE s, thread $TID, queue said: $OUT"; tail -1 "$RUN/model-replies.jsonl" | cut -c1-260; } > runs/long-codex.result
  touch "$RUN/stop"; kill "$(cat "$RUN/fake-model.pid")" 2>/dev/null
}
opencode_host() {
  local RUN; RUN=$(opencode/prepare.sh long-opencode); sed -i '' 's|^export |export OPENCODE_PASSWORD="probe-only" |' "$RUN/env.sh"
  python3 -c "import json,sys;p=sys.argv[1]+'/workspace/opencode.json';c=json.load(open(p));c['model']='opencode/flint-40b-free';json.dump(c,open(p,'w'))" "$RUN"
  local PORT=$((20000 + RANDOM % 20000))
  (cd "$RUN/workspace" && env -i bash -c "source '$RUN/env.sh'; exec opencode serve --hostname 127.0.0.1 --port $PORT" > "$RUN/serve.log" 2>&1 & echo $! > "$RUN/serve.pid"); nap 4
  node -e 'const fs=require("fs");const run=process.argv[1],port=process.argv[2],wall=Number(process.argv[3]);const env={};for(const m of fs.readFileSync(run+"/env.sh","utf8").matchAll(/(\w+)="([^"]*)"/g))env[m[1]]=m[2];env.TERM="xterm-256color";fs.writeFileSync(run+"/command.json",JSON.stringify({executable:"opencode",args:["--server","http://127.0.0.1:"+port,"--auto","--prompt","Call the fixture job_send tool once with task \"probe\". Then reply with the single word SENT."],cwd:run+"/workspace",env,wallSec:wall}));' "$RUN" "$PORT" "$WALL"
  (python3 tui.py "$RUN" > "$RUN/driver.log" 2>&1 &); until_call "$RUN"
  local SID; SID=$(node -e 'const fs=require("fs");let l;try{l=fs.readFileSync(process.argv[1]+"/fixture.jsonl","utf8").trim().split("\n").map(JSON.parse).find(r=>r.event==="call")}catch{};console.log(l?l.meta["ai.opencode/sessionID"]:"")' "$RUN")
  nap $IDLE
  local OUT; OUT=$(cd "$RUN/workspace" && env -i bash -c "source '$RUN/env.sh'; perl -e 'alarm 120; exec @ARGV' opencode run --server http://127.0.0.1:$PORT -s $SID 'THREAD-NEWS after an idle hour. Reply with the single word WOKEN.'" 2>&1 < /dev/null | tr -d '\033' | tail -3 | tr '\n' ' ')
  echo "opencode: idle $IDLE s, session $SID, poster output: ${OUT:0:200}" > runs/long-opencode.result
  touch "$RUN/stop"; kill "$(cat "$RUN/serve.pid")" 2>/dev/null
}
copilot_host() {
  local RUN; RUN=$(copilot/prepare.sh long-copilot); mkdir -p "$RUN/copilot-home/extensions/probe-wake"
  cat > "$RUN/copilot-home/extensions/probe-wake/extension.mjs" <<JS
import { joinSession } from "@microsoft/copilot-sdk/extension";
import fs from "node:fs";
const run = "$RUN";
const log = (event, data = {}) => fs.appendFileSync(run + "/extension.jsonl", JSON.stringify({ t: Date.now(), event, ...data }) + "\n");
const session = await joinSession({ tools: [], hooks: {} });
log("joined", { sessionId: session.sessionId ?? null });
setInterval(async () => { let text; try { text = fs.readFileSync(run + "/trigger.txt", "utf8"); fs.unlinkSync(run + "/trigger.txt"); } catch { return; }
  try { log("sent", { messageId: await session.send(text) }); } catch (err) { log("send-failed", { error: String(err) }); } }, 500);
JS
  node -e 'const fs=require("fs");const run=process.argv[1],wall=Number(process.argv[2]);const env={};for(const m of fs.readFileSync(run+"/env.sh","utf8").matchAll(/(\w+)="?([^"\s]*)"?/g))env[m[1]]=m[2];fs.writeFileSync(run+"/command.json",JSON.stringify({executable:"copilot",args:["-i","PROBE-CALL job_send {\"task\":\"probe\"}","--experimental","--additional-mcp-config","@"+run+"/mcp.json","--allow-all-tools","--no-custom-instructions"],cwd:run+"/workspace",env,wallSec:wall}));' "$RUN" "$WALL"
  (python3 tui.py "$RUN" > "$RUN/driver.log" 2>&1 &); nap 7; node tui-send.mjs "$RUN" '\r'; until_call "$RUN"
  nap $IDLE
  local N; N=$(ls "$RUN/model-requests" | wc -l | tr -d ' '); echo "THREAD-NEWS after an idle hour." > "$RUN/trigger.txt"; nap 20
  { echo "copilot: idle $IDLE s, model requests before=$N after=$(ls "$RUN/model-requests" | wc -l | tr -d ' ')"; tail -1 "$RUN/extension.jsonl" | cut -c1-160; tail -1 "$RUN/model-replies.jsonl" | cut -c1-200; } > runs/long-copilot.result
  touch "$RUN/stop"; kill "$(cat "$RUN/fake-model.pid")" 2>/dev/null
}
antigravity_host() {
  local RUN="$HERE/runs/long-agy-$(date -u +%Y-%m-%dT%H-%M-%S)"; mkdir -p "$RUN/workspace"
  cat > "$RUN/waiter.sh" <<SH
#!/bin/sh
echo "began at \$(date +%s)" >> "$RUN/waiter.log"
sleep $IDLE
"\$HOME/.gemini/antigravity-cli/bin/agentapi" send-message "\$ANTIGRAVITY_CONVERSATION_ID" "THREAD-NEWS after an idle hour. To acknowledge, run exactly this one shell command and nothing else: sh $RUN/ack.sh" > "$RUN/waiter.out" 2>&1
echo "sent exit=\$? at \$(date +%s)" >> "$RUN/waiter.log"
SH
  cat > "$RUN/start-waiter.sh" <<SH
#!/bin/sh
perl -e 'use POSIX; exit if fork; POSIX::setsid(); exit if fork; open STDIN, "</dev/null"; open STDOUT, ">/dev/null"; open STDERR, ">/dev/null"; exec @ARGV' sh "$RUN/waiter.sh"
echo started > "$RUN/waiter-started.txt"; echo started
SH
  cat > "$RUN/ack.sh" <<SH
#!/bin/sh
echo "acked at \$(date +%s) by a child of \$(ps -o ppid= -p \$\$ | tr -d ' ')" >> "$RUN/woken.marker"; echo acknowledged
SH
  chmod +x "$RUN"/*.sh
  node -e 'const fs=require("fs");const run=process.argv[1],wall=Number(process.argv[2]);const allow=[];for(const s of ["start-waiter.sh","ack.sh"])allow.push("command(sh "+run+"/"+s+")","command("+run+"/"+s+")");allow.push("command(sh)");const env={PATH:process.env.PATH,HOME:process.env.HOME,USER:process.env.USER,LANG:"en_US.UTF-8",TERM:"xterm-256color",TMPDIR:process.env.TMPDIR};fs.writeFileSync(run+"/command.json",JSON.stringify({executable:"agy",args:["-i","Run exactly this one shell command and nothing else: sh "+run+"/start-waiter.sh   Then reply with the single word STARTED and stop.","--model","gemini-3.8-flash-low","--settings",JSON.stringify({permissions:{allow}})],cwd:run+"/workspace",env,wallSec:wall}));' "$RUN" "$WALL"
  (python3 tui.py "$RUN" > "$RUN/driver.log" 2>&1 &); until_file "$RUN/waiter-started.txt" 40
  until_file "$RUN/woken.marker" $(( (IDLE + 200) / 2 ))
  { echo "antigravity: idle $IDLE s"; cat "$RUN/waiter.log" 2>/dev/null; cat "$RUN/woken.marker" 2>/dev/null || echo "no acknowledgement"; } > runs/long-antigravity.result
  touch "$RUN/stop"
}
rm -f runs/long-*.result
claude_host & codex_host & opencode_host & copilot_host & antigravity_host &
wait
