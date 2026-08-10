import net from 'node:net';
const SOCK=process.argv[2], cwd=process.argv[3];
const c=net.createConnection(SOCK);let id=1;const pend=new Map();const notes=[];let buf='';
c.on('data',ch=>{buf+=ch.toString();const ls=buf.split('\n');buf=ls.pop()||'';
 for(const l of ls){if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}
  if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){const p=pend.get(m.id);pend.delete(m.id);p&&(m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result));}
  else if(m.method) notes.push(m);}});
const call=(m,p)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});c.write(JSON.stringify({jsonrpc:'2.0',id:i,method:m,params:p})+'\n');});
await new Promise(r=>c.on('connect',r)); await call('initialize',{clientInfo:{name:'errs',version:'1'}});
const ZERO='00000000-0000-0000-0000-000000000000';
const t=async(name,m,p)=>{try{const r=await call(m,p);console.log(`OK   ${name}: ${JSON.stringify(r).slice(0,150)}`);}
  catch(e){console.log(`ERR  ${name}: ${e.message.slice(0,220)}`);}};
await t('thread/read unknown id','thread/read',{threadId:ZERO,includeTurns:true});
await t('thread/resume unknown id','thread/resume',{threadId:ZERO});
await t('turn/interrupt unknown','turn/interrupt',{threadId:ZERO,turnId:ZERO});
await t('turn/steer unknown thread','turn/steer',{threadId:ZERO,expectedTurnId:ZERO,input:[{type:'text',text:'x'}]});
await t('model/list','model/list',{});
const th=await call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'never'});
await t('steer with stale expectedTurnId on idle thread','turn/steer',{threadId:th.thread.id,expectedTurnId:ZERO,input:[{type:'text',text:'x'}]});
const turn=await call('turn/start',{threadId:th.thread.id,input:[{type:'text',text:'Run `sleep 25` then reply A.'}]});
await new Promise(r=>setTimeout(r,4000));
await t('turn/start while a turn is IN PROGRESS','turn/start',{threadId:th.thread.id,input:[{type:'text',text:'Reply B.'}]});
await t('turn/steer with the CORRECT turnId','turn/steer',{threadId:th.thread.id,expectedTurnId:turn.turn.id,input:[{type:'text',text:'Actually just reply STEERED.'}]});
await t('turn/interrupt the real turn','turn/interrupt',{threadId:th.thread.id,turnId:turn.turn.id});
await new Promise(r=>setTimeout(r,3000));
const d=notes.filter(n=>n.method==='turn/completed').pop();
console.log('final turn status:',d?.params?.turn?.status,'| answer:',JSON.stringify((d?.params?.turn?.items||[]).filter(i=>i.type==='agentMessage').pop()?.text));
c.end();process.exit(0);
