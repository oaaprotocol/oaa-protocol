import * as M from './mock.mjs';M.install({local:'http://127.0.0.1:8106'});
const w=(await import('../dist/worker.js')).default;
const kv=new Map();const env={AI:{run:async()=>({response:'ok'})},MEDIA:{get:async k=>kv.get(k)??null,put:async(k,v)=>kv.set(k,v)},TREASURY:'0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',AGENTS_FAIR_USE:'8'};
const post=(p,b,ip='7.7.7.7')=>w.fetch(new Request('https://api.oaap.si'+p,{method:'POST',headers:{Origin:'https://oaap.netlify.app','Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify(b)}),env).then(async r=>[r.status,await r.json()]);
const c=await post('/agent/config',{});console.log('config paid=',c[1].paid,'perDay=',c[1].freePerDay);
let codes=[];for(let i=0;i<9;i++){const r=await post('/agent/chat',{agent:'zen',messages:[{role:'user',content:'signal for ETH'}]});codes.push(r[0]+(r[1].error?':'+r[1].error:''))}console.log('chats',codes.join(' '));
const m=await post('/agent/market',{});console.log('market own',m[1].own.length,'items',m[1].items.length);
