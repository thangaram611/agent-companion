// P-B: after the app-server that owned a thread DIES, can a brand-new
// app-server resume that thread from disk, with history intact?
import { makeStdioServer, sleep } from './stdio-lib.mjs';
const t0=Date.now(); const log=(...a)=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s]`,...a);
const [threadId, cwd] = process.argv.slice(2);
let done=false, answer=null, status=null;
const S = makeStdioServer({ tag:'probeB', onNotify:(m)=>{
  if(m.method==='turn/completed'){done=true;status=m.params?.turn?.status;
    answer=(m.params?.turn?.items||[]).filter(i=>i.type==='agentMessage').pop()?.text;}
  if(!/Delta|tokenUsage|rateLimits/.test(m.method)) log('  <=',m.method,JSON.stringify(m.params?.item?.type||m.params?.turn?.status||'').slice(0,30));}});
await S.init();
log('NEW app-server pid', S.pid, '(the one that owned the thread is dead)');

// 1. Is the dead thread even visible to a fresh server?
const loaded = await S.call('thread/loaded/list',{});
log('thread/loaded/list on a fresh server:', JSON.stringify(loaded).slice(0,160));

// 2. Resume it from disk.
let r;
try { r = await S.call('thread/resume',{ threadId }); log('RESUME OK. status=', JSON.stringify(r.thread?.status), '| turns in payload:', (r.thread?.turns||[]).length); }
catch (e) { log('RESUME FAILED:', e.message.slice(0,300)); process.exit(1); }

// 3. Is the prior history actually there?
const rd = await S.call('thread/read',{threadId, includeTurns:true});
const turns = rd.thread.turns||[];
log('thread/read turns:', turns.length, turns.map(t=>`${t.status}(${(t.items||[]).length} items)`).join(', '));
for (const t of turns) for (const i of (t.items||[])) log('    item:', i.type, i.phase||'', JSON.stringify((i.text||'').slice(0,60)));

// 4. Does the resumed thread still REMEMBER? (continuity across server death)
await S.call('turn/start',{threadId,input:[{type:'text',text:'Without running any command: what shell commands did I ask you to run in my FIRST message, and did you finish them? Answer in one short sentence.'}]});
await new Promise(res=>{const iv=setInterval(()=>{if(done){clearInterval(iv);res();}},300); setTimeout(()=>{clearInterval(iv);res();},120000);});
log('CONTINUITY ANSWER:', JSON.stringify(answer), '| status', status);
S.child.kill(); process.exit(0);
