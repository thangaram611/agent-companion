// Start a long turn, DISCONNECT the only client entirely, wait with ZERO clients,
// then reconnect and see whether the turn kept running.
const URL=process.argv[3]||'ws://127.0.0.1:8795';
const cwd=process.argv[2];
const t0=Date.now(); const log=(...a)=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s]`,...a);
function client(name){const ws=new WebSocket(URL);let id=1;const pend=new Map();const ev=[];
  ws.addEventListener('message',e=>{for(const l of String(e.data).split('\n')){if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}
    if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){const p=pend.get(m.id);pend.delete(m.id);p&&(m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result));}
    else if(m.method){ev.push(m); if(!/Delta|tokenUsage|rateLimits/.test(m.method)) log(`${name} <=`,m.method, JSON.stringify(m.params?.item?.type||m.params?.turn?.status||'').slice(0,40));}}});
  const call=(method,params)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});ws.send(JSON.stringify({jsonrpc:'2.0',id:i,method,params}));});
  return {ws,call,ev,ready:new Promise(r=>ws.addEventListener('open',async()=>{await call('initialize',{clientInfo:{name,version:'1'}});ws.send(JSON.stringify({jsonrpc:'2.0',method:'initialized',params:{}}));r();}))};
}
const A=client('A'); await A.ready;
const th=await A.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'never',ephemeral:false});
const threadId=th.thread.id; log('thread',threadId);
const turn=await A.call('turn/start',{threadId,input:[{type:'text',text:'Run `sleep 20 && echo S1`, then `sleep 20 && echo S2`, then `sleep 20 && echo S3`, waiting for each. Then reply exactly THREEDONE.'}]});
log('turn',turn.turn.id);
await new Promise(r=>setTimeout(r,8000));
log('>>> CLOSING the only client. Zero clients from here.');
A.ws.close();
await new Promise(r=>setTimeout(r,50000));   // 50s with NOBODY attached
log('>>> 50s elapsed with zero clients. Reconnecting as B.');
const B=client('B'); await B.ready;
const loaded=await B.call('thread/loaded/list',{});
log('loaded/list while detached:',JSON.stringify(loaded));
const r=await B.call('thread/resume',{threadId});
log('resume status:',JSON.stringify(r.thread?.status));
await new Promise(res=>{const iv=setInterval(()=>{const done=B.ev.find(e=>e.method==='turn/completed');if(done){clearInterval(iv);
  const items=done.params?.turn?.items||[];const fin=items.filter(i=>i.type==='agentMessage').pop();
  log('TURN COMPLETED. status=',done.params?.turn?.status,'answer=',JSON.stringify(fin?.text));res();}},300);
  setTimeout(()=>{clearInterval(iv);log('no turn/completed within 90s after reattach');res();},90000);});
const rd=await B.call('thread/read',{threadId,includeTurns:true});
const t=rd.thread.turns?.[0];
log('thread/read turn status:',t?.status,'durationMs:',t?.durationMs,'items:',(t?.items||[]).map(i=>i.type+':'+(i.phase||'')).join(','));
log('final answer via read:',JSON.stringify((t?.items||[]).filter(i=>i.type==='agentMessage').pop()?.text));
process.exit(0);
