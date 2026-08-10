// Two CONCURRENT clients on one broker, each its own thread: does id remapping
// keep responses straight, and does one thread's work reach the wrong client?
import net from 'node:net';
const SOCK=process.argv[2], cwd=process.argv[3];
const t0=Date.now(); const log=(...a)=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s]`,...a);
function mk(name){const c=net.createConnection(SOCK);let id=1;const pend=new Map();const notes=[];let buf='';
 c.on('data',ch=>{buf+=ch.toString();const ls=buf.split('\n');buf=ls.pop()||'';
  for(const l of ls){if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}
   if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){const p=pend.get(m.id);pend.delete(m.id);p&&(m.error?p.rej(new Error(JSON.stringify(m.error))):p.res(m.result));}
   else if(m.method) notes.push(m);}});
 const call=(method,params)=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});c.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n');});
 return {c,call,notes,name,ready:new Promise(r=>c.on('connect',async()=>{await call('initialize',{clientInfo:{name,version:'1'}});r();}))};}
const A=mk('A'), B=mk('B'); await Promise.all([A.ready,B.ready]);
const [ta,tb]=await Promise.all([
  A.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'never'}),
  B.call('thread/start',{cwd,sandbox:'read-only',approvalPolicy:'never'})]);
log('A thread',ta.thread.id); log('B thread',tb.thread.id);
log('DISTINCT THREADS:', ta.thread.id!==tb.thread.id);
await Promise.all([
  A.call('turn/start',{threadId:ta.thread.id,input:[{type:'text',text:'Reply with exactly the word ALPHA.'}]}),
  B.call('turn/start',{threadId:tb.thread.id,input:[{type:'text',text:'Reply with exactly the word BETA.'}]})]);
await new Promise(r=>setTimeout(r,45000));
const fin=(cl,tid)=>{const d=cl.notes.filter(n=>n.method==='turn/completed'&&n.params?.threadId===tid).pop();
  return (d?.params?.turn?.items||[]).filter(i=>i.type==='agentMessage').pop()?.text;};
log('A got for A-thread:',JSON.stringify(fin(A,ta.thread.id)));
log('B got for B-thread:',JSON.stringify(fin(B,tb.thread.id)));
// Broadcast check: does A also SEE B's notifications? (it will — broker fans out)
const aSawB=A.notes.some(n=>n.params?.threadId===tb.thread.id);
log('A also received B-thread notifications (broadcast fan-out):',aSawB,'<- a real broker must filter by subscription');
A.c.end();B.c.end();process.exit(0);
