import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp, createHandler } from '../server.js';
import { buildSale, validDocument, signPayment, verifyPayment } from '../lib/payment.js';

const secret = 'unit-test-secret-that-is-at-least-32-characters';
const input = (bumps=[]) => ({requestId:randomUUID(),bumps,customer:{name:'Pessoa Teste',email:'teste@example.com',emailConfirmation:'teste@example.com',document:'52998224725',phone:'11999999999'},shipping:{name:'Pessoa Teste',street:'Rua Teste',number:'10',neighborhood:'Centro',city:'Salvador',state:'BA',zipCode:'40000000'}});
test('all four totals are computed in cents on the server',()=>{
  for (const [bumps,amount] of [[[],39770],[['book'],44770],[['course'],59470],[['book','course'],64470]]) {
    const sale=buildSale(input(bumps)); assert.equal(sale.amount,amount); assert.equal(sale.items.reduce((s,i)=>s+i.unitPrice*i.quantity,0),amount); assert.equal(sale.paymentMethod,'pix');
  }
});
test('tampered amounts, duplicate and unknown bumps are rejected',()=>{
  assert.throws(()=>buildSale({...input(),amount:1}));
  for (const bumps of [['main'],['book','book'],['unknown'],null]) assert.throws(()=>buildSale({...input(),bumps}));
});
test('CPF/CNPJ check digits, email confirmation, mobile and shipping',()=>{
  assert.equal(validDocument('52998224725'),true); assert.equal(validDocument('11222333000181'),true);
  for (const value of ['11111111111','52998224726','00000000000000','11222333000182','123']) assert.equal(validDocument(value),false);
  for (const [key,value] of [['emailConfirmation','different@example.com'],['email','invalid'],['document','52998224726'],['phone','123']]) {
    const data=input(); data.customer[key]=value; assert.throws(()=>buildSale(data));
  }
  const data=input(['book']);delete data.shipping;assert.throws(()=>buildSale(data));
  assert.equal(buildSale(input()).shipping,undefined);
  assert.equal(buildSale(input(['book'])).items.find(x=>x.tangible).unitPrice,5000);
});
test('signed tokens reject tampering, expiry and a different secret',()=>{
  const data={id:'TXN-123',amount:39770,exp:Date.now()+10000};const token=signPayment(data,secret);
  assert.deepEqual(verifyPayment(token,secret),data);
  assert.throws(()=>verifyPayment(token+'x',secret));assert.throws(()=>verifyPayment(token,'other-secret'));assert.throws(()=>verifyPayment(token,secret,Date.now()+20000));
});
async function fixture(t,fetcher,options={}) {
  const app=createApp({apiKey:'test-only',secret,fetch:fetcher,...options});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.closeAllConnections();app.close(resolve);}));
  const base=`http://127.0.0.1:${app.address().port}`;
  const post=(route,data,headers={})=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
  return {base,post};
}
const success = (amount=39770,status='PENDING') => ({success:true,data:{transactionId:'TXN-123',amount,status,paymentMethod:'PIX',paymentData:{copyPaste:'000201010212TEST-PIX-FIXTURE-NOT-PAYABLE',expiresAt:new Date(Date.now()+86400000).toISOString()}}});
test('create → QR → signed status uses the documented Black Cat contract',async t=>{
  const calls=[];
  const {post}=await fixture(t,async(url,options)=>{calls.push({url,options});return Response.json(success(39770,options.method==='GET'?'PAID':'PENDING'));});
  const response=await post('/api/pix',input());assert.equal(response.status,201);
  const result=await response.json();assert.match(result.qrCode,/^data:image\/png;base64,/);assert.equal(result.amount,39770);assert.equal(result.status,'PENDING');
  const status=await post('/api/pix/status',{token:result.token});assert.deepEqual(await status.json(),{status:'PAID',amount:39770});
  assert.equal(calls[0].url,'https://api.blackcatoficial.com/api/sales/create-sale');assert.equal(calls[0].options.headers['X-API-Key'],'test-only');assert.equal(calls[1].url,'https://api.blackcatoficial.com/api/sales/TXN-123/status');
  assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
});
test('simultaneous duplicate creation calls create only one charge',async t=>{
  let calls=0;const {post}=await fixture(t,async()=>{calls++;await new Promise(r=>setTimeout(r,20));return Response.json(success());});
  const data=input();const results=await Promise.all([post('/api/pix',data),post('/api/pix',data)]);
  assert.equal(calls,1);assert.deepEqual(await results[0].json(),await results[1].json());
  const changed=await post('/api/pix',{...data,bumps:['course']});assert.equal(changed.status,409);
});
test('uncertain creation is never automatically sent again',async t=>{
  let calls=0;const {post}=await fixture(t,async()=>{calls++;throw new Error('timeout with sensitive upstream details');});
  const data=input();for(let i=0;i<2;i++){const r=await post('/api/pix',data);assert.equal(r.status,502);const body=await r.json();assert.equal(body.code,'GATEWAY_NETWORK');assert.ok(!body.error.includes('sensitive'));}assert.equal(calls,1);
});
test('missing credentials, cross-origin, invalid content type and forged token fail closed',async t=>{
  let calls=0;const upstream=async()=>{calls++;return Response.json(success());};
  const unconfigured=await fixture(t,upstream,{apiKey:''});assert.equal((await unconfigured.post('/api/pix',input())).status,503);
  const {post,base}=await fixture(t,upstream);
  assert.equal((await post('/api/pix',input(),{Origin:'https://evil.example'})).status,403);
  assert.equal((await post('/api/pix',input(),{'Content-Type':'text/plain'})).status,415);
  assert.equal((await post('/api/pix/status',{token:'forged'})).status,401);
  assert.equal((await fetch(base+'/api/pix')).status,405);assert.equal((await fetch(base+'/.env')).status,404);assert.equal(calls,0);
});
test('amount and transaction mismatch from upstream never become a confirmed payment',async t=>{
  const {post}=await fixture(t,async()=>Response.json(success(1,'PAID')));
  assert.equal((await post('/api/pix',input())).status,502);
  assert.equal((await post('/api/pix/status',{token:signPayment({id:'TXN-123',amount:39770,exp:Date.now()+10000},secret)})).status,502);
});
test('status supports cancelled and refunded, provider errors remain errors',async t=>{
  let next='CANCELLED';const {post}=await fixture(t,async()=>next==='ERROR'?Response.json({success:false},{status:500}):Response.json(success(39770,next)));
  const token=signPayment({id:'TXN-123',amount:39770,exp:Date.now()+10000},secret);
  for (const status of ['CANCELLED','REFUNDED']){next=status;assert.equal((await (await post('/api/pix/status',{token})).json()).status,status);}
  next='ERROR';assert.equal((await post('/api/pix/status',{token})).status,502);
});
test('request size and generation rate are bounded',async t=>{
  const {post}=await fixture(t,async()=>Response.json(success()));
  assert.equal((await post('/api/pix',{padding:'a'.repeat(13000)})).status,413);
  for(let i=0;i<5;i++) assert.equal((await post('/api/pix',input())).status,201);
  assert.equal((await post('/api/pix',input())).status,429);
});
test('Vercel parsed bodies preserve validation and response contract',async()=>{
  let calls=0;
  const handler=createHandler({trustProxy:true,apiKey:'test-only',secret,fetch:async()=>{calls++;return Response.json(success());}});
  async function invoke(body,origin='https://checkout.test') {
    let code,result;const headers={};
    await handler({url:'/api/pix',method:'POST',headers:{host:'checkout.test','x-forwarded-proto':'https',origin,'content-type':'application/json'},body,socket:{remoteAddress:'127.0.0.1'}},{setHeader(k,v){headers[k]=v;},writeHead(c){code=c;},end(value){result=JSON.parse(value);}});
    return {code,result};
  }
  assert.equal((await invoke(input())).code,201);
  assert.equal((await invoke({...input(),amount:1})).code,400);
  assert.equal((await invoke({padding:'a'.repeat(13000)})).code,413);
  assert.equal((await invoke(input(),'https://evil.example')).code,403);
  assert.equal(calls,1);
});

test('both Vercel domain aliases pass without APP_ORIGIN while cross-site requests fail',async()=>{
  let calls=0;
  const handler=createHandler({trustProxy:true,apiKey:'test-only',secret,fetch:async()=>{calls++;return Response.json(success());}});
  async function invoke(host,origin,site='same-origin') {
    let code;
    await handler({url:'/api/pix',method:'POST',headers:{host,'x-forwarded-proto':'https',origin,'sec-fetch-site':site,'content-type':'application/json'},body:input(),socket:{remoteAddress:'127.0.0.1'}},{
      setHeader(){},writeHead(status){code=status;},end(){}
    });
    return code;
  }
  for(const host of ['instituito.vercel.app','institutobaumgarth.vercel.app'])
    assert.equal(await invoke(host,'https://'+host),201);
  assert.equal(await invoke('institutobaumgarth.vercel.app','https://instituito.vercel.app'),403);
  assert.equal(await invoke('institutobaumgarth.vercel.app','https://institutobaumgarth.vercel.app','cross-site'),403);
  assert.equal(await invoke('institutobaumgarth.vercel.app',undefined),403);
  assert.equal(calls,2);
});

test('Black Cat authorization and validation errors show actionable safe codes',async t=>{
  for (const [http,code,status,text] of [
    [401,'GATEWAY_AUTH',503,'chave da API'],
    [403,'GATEWAY_FORBIDDEN',503,'autorizada'],
    [400,'GATEWAY_VALIDATION',502,'HTTP 400'],
    [422,'GATEWAY_VALIDATION',502,'HTTP 422'],
    [429,'GATEWAY_RATE_LIMIT',503,'limitou']
  ]) {
    const {post}=await fixture(t,async()=>Response.json({
      success:false,message:'secret-provider-details-MUST-NOT-LEAK',
      error:'private-diagnostic-MUST-NOT-LEAK'
    },{status:http}));
    const response=await post('/api/pix',input());
    const result=await response.json();
    assert.equal(response.status,status);
    assert.equal(result.code,code);
    assert.match(result.error,new RegExp(text,'i'));
    assert.ok(!JSON.stringify(result).includes('MUST-NOT-LEAK'));
  }
});

test('Black Cat timeout or unexpected response is marked as uncertain',async t=>{
  const timeout=await fixture(t,async()=>{
    const e=new Error('private-internal-server-address');
    e.name='TimeoutError';throw e;
  });
  const r1=await timeout.post('/api/pix',input());const b1=await r1.json();
  assert.equal(r1.status,502);assert.equal(b1.code,'GATEWAY_TIMEOUT');
  assert.ok(!JSON.stringify(b1).includes('private-internal-server-address'));

  const invalidJson=await fixture(t,async()=>({
    status:200,ok:true,json:async()=>{throw Error('upstream body contains secrets');}
  }));
  const r2=await invalidJson.post('/api/pix',input());const b2=await r2.json();
  assert.equal(r2.status,502);assert.equal(b2.code,'PAYMENT_UNCERTAIN');
  assert.ok(!JSON.stringify(b2).includes('secrets'));
});

test('a successful but incomplete Pix response cannot be offered for payment',async t=>{
  const {post}=await fixture(t,async()=>Response.json({
    success:true,data:{...success().data,paymentData:{expiresAt:new Date(Date.now()+86400000).toISOString()}}
  }));
  const response=await post('/api/pix',input());
  assert.equal(response.status,502);
  const body=await response.json();
  assert.equal(body.code,'PAYMENT_UNCERTAIN');
});
