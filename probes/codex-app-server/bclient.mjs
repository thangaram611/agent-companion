// Short-lived bridge-process stand-in: connect to the broker UDS, do a job, exit.
import net from 'node:net';
const [SOCK, role, arg] = process.argv.slice(2);
const t0=Date.now(); const log=(...a)=>console.log(`[${role}][${((Date.now()-t0)/1000).toFixed(1)}s]`,...a);
const c = net.createConnection(SOCK);
let id=1; const pend=new Map(); const notes=[];
const call=(method,params)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});c.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n');});
let buf='';
c.on('data',ch=>{buf+=ch.toString();const ls=buf.split('\n');buf=ls.pop()||'';
  for(const l of ls){if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}
    if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){const p=pend.get(m.id);pend.delete(m.id);p&&(m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result));}
    else if(m.method){notes.push(m); if(!/Delta|tokenUsage|rateLimits/.test(m.method)) log('<=',m.method,JSON.stringify(m.params?.item?.type||m.params?.turn?.status||'').slice(0,28));}}});
await new Promise(r=>c.on('connect',r));
const init=await call('initialize',{clientInfo:{name:`bridge-${role}`,version:'1'}});
log('broker handshake:',JSON.stringify(init));
if(role==='start'){
  const th=await call('thread/start',{cwd:arg,sandbox:'read-only',approvalPolicy:'never',ephemeral:false});
  const turn=await call('turn/start',{threadId:th.thread.id,input:[{type:'text',text:'Run `sleep 15 && echo B1`, then `sleep 15 && echo B2`, waiting for each. Then reply exactly BROKERDONE.'}]});
  log('started thread',th.thread.id,'turn',turn.turn.id);
  console.log('THREADID='+th.thread.id);
  await new Promise(r=>setTimeout(r,6000));
  log('disconnecting (simulating the bridge process ending)');
} else if(role==='attach'){
  const loaded=await call('thread/loaded/list',{});
  log('loaded/list:',JSON.stringify(loaded).slice(0,120));
  const r=await call('thread/resume',{threadId:arg});
  log('resume status:',JSON.stringify(r.thread?.status));
  await new Promise(res=>{const iv=setInterval(()=>{const d=notes.find(n=>n.method==='turn/completed');
    if(d){clearInterval(iv);const fin=(d.params?.turn?.items||[]).filter(i=>i.type==='agentMessage').pop();
      log('TURN COMPLETED status=',d.params?.turn?.status,'answer=',JSON.stringify(fin?.text));res();}},300);
    setTimeout(()=>{clearInterval(iv);log('no completion within 120s');res();},120000);});
}
c.end(); process.exit(0);
