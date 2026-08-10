// P-A: does the STABLE stdio transport work, and what is the app-server's
// lifetime relative to the process that owns its stdio?
import { makeStdioServer, sleep, alive } from './stdio-lib.mjs';
const t0=Date.now(); const log=(...a)=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s]`,...a);
const cwd = process.argv[2];
const events=[];
const S = makeStdioServer({ tag:'probeA', onNotify:(m)=>{ events.push(m);
  if(!/Delta|tokenUsage|rateLimits/.test(m.method)) log('  <=', m.method, JSON.stringify(m.params?.item?.type||m.params?.turn?.status||'').slice(0,30)); }});
log('app-server child pid', S.pid);
const init = await S.init();
log('initialize OK over stdio:', JSON.stringify(init).slice(0,140));
const th = await S.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'never',ephemeral:false});
log('thread', th.thread.id, '| rollout', th.thread.path.split('/').pop());
const turn = await S.call('turn/start',{threadId:th.thread.id,input:[{type:'text',text:'Run `sleep 12 && echo A1`, then `sleep 12 && echo A2`, waiting for each. Then reply exactly TWODONE.'}]});
log('turn', turn.turn.id);
await sleep(9000);
log('--- app-server alive before parent exit?', alive(S.pid));
// Record what the caller needs, then exit WITHOUT killing the child.
console.log('HANDOFF ' + JSON.stringify({ serverPid:S.pid, threadId:th.thread.id, turnId:turn.turn.id, rollout:th.thread.path }));
process.exit(0);   // parent dies; child's stdin/stdout pipes close
