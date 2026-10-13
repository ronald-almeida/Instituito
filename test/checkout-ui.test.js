import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/checkout.js',import.meta.url),'utf8');

function fixture({initialStorage = {}, createPayment} = {}) {
  const saved = new Map(Object.entries(initialStorage));
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const handlers = {};
      elements.set(id,{
        handlers,id,hidden:false,disabled:false,checked:false,value:'',textContent:'',
        addEventListener(event,fn){handlers[event]=fn;},
        setCustomValidity(value){this.validationError=value;},
        reportValidity(){return false;},
        focus(){},
        scrollIntoView(){}
      });
    }
    return elements.get(id);
  }
  const values = {
    name:'Pessoa Teste',email:'teste@example.com',emailConfirmation:'teste@example.com',
    document:'52998224725',phone:'11999999999'
  };
  for(const [id,value] of Object.entries(values)) element(id).value=value;
  const document = {
    hidden:false,
    getElementById:element,
    addEventListener(){}
  };
  const requests=[];
  let sequence=0;
  const uuid=()=>`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
  const samplePayment=n=>({
    transactionId:'TXN-'+n,amount:39770,status:'PENDING',
    token:'token-'+n,copyPaste:'000201010212TEST'+n,
    qrCode:'data:image/png;base64,iVBORw0KGgo=',
    expiresAt:new Date(Date.now()+600000).toISOString()
  });
  let upstream=0;
  const fetch=async (path,opts)=>{
    if(path==='/api/pix/status') return {ok:true,json:async()=>({status:'PENDING'})};
    const data=JSON.parse(opts.body);
    requests.push(data);
    const response=createPayment
      ? await createPayment(data,requests.length)
      : samplePayment(++upstream);
    return response && Object.hasOwn(response,'ok')
      ? {ok:response.ok,json:async()=>response.json}
      : {ok:true,json:async()=>response};
  };
  runInNewContext(source,{
    document,fetch,
    sessionStorage:{
      getItem:k=>saved.get(k)??null,
      setItem:(k,v)=>saved.set(k,v),
      removeItem:k=>saved.delete(k)
    },
    navigator:{clipboard:{writeText:async()=>{}}},
    FormData:class {get(key){return element(key).value;}},
    crypto:{randomUUID:uuid},
    AbortSignal:{timeout:()=>undefined},
    setTimeout:()=>1,clearTimeout:()=>{},
    console
  },{filename:'checkout.js'});
  const submit=()=>element('checkout-form').handlers.submit({preventDefault(){}});
  const clickNew=()=>element('new-purchase').handlers.click();
  return {element,saved,requests,submit,clickNew,samplePayment};
}

test('previous duplicate-payment lock no longer disables the checkout',()=>{
  const f=fixture({initialStorage:{'pix-attempt-pending':'true','pix-request-id':'legacy-order'}});
  assert.equal(f.saved.has('pix-attempt-pending'),false);
  assert.equal(f.saved.has('pix-request-id'),false);
  assert.equal(f.element('purchase-fields').disabled,false);
  assert.equal(f.element('checkout-form').hidden,false);
});

test('an uncertain Pix response allows manual retry with a fresh request ID',async()=>{
  const f=fixture({createPayment:(_data,n)=>n===1
    ? {ok:false,json:{code:'PAYMENT_UNCERTAIN',error:'Resposta inconclusiva'}}
    : {transactionId:'TXN-2',amount:39770,status:'PENDING',
      token:'token-2',copyPaste:'000201010212TEST',
      qrCode:'data:image/png;base64,iVBORw0KGgo=',
      expiresAt:new Date(Date.now()+600000).toISOString()}});
  await f.submit();
  assert.equal(f.element('purchase-fields').disabled,false);
  assert.equal(f.element('generate').disabled,false);
  assert.equal(f.element('checkout-form').hidden,false);
  assert.match(f.element('form-error').textContent,/Código: PAYMENT_UNCERTAIN/);
  assert.match(f.element('form-error').textContent,/Referência:/);
  await f.submit();
  assert.equal(f.requests.length,2);
  assert.notEqual(f.requests[0].requestId,f.requests[1].requestId);
  assert.equal(f.element('payment').hidden,false);
  assert.equal(f.element('checkout-form').hidden,true);
});

test('new purchase action clears previous Pix and allows another independent charge',async()=>{
  const f=fixture();
  await f.submit();
  assert.equal(f.requests.length,1);
  assert.ok(f.saved.has('pix-payment'));
  f.clickNew();
  assert.equal(f.element('checkout-form').hidden,false);
  assert.equal(f.element('purchase-fields').disabled,false);
  assert.equal(f.element('payment').hidden,true);
  assert.equal(f.saved.has('pix-payment'),false);
  await f.submit();
  assert.equal(f.requests.length,2);
  assert.notEqual(f.requests[0].requestId,f.requests[1].requestId);
});

test('restored Pix can be replaced with a new purchase rather than locking the form',()=>{
  const payment={transactionId:'TXN-OLD',amount:39770,status:'PENDING',
    token:'old-token',copyPaste:'000201010212OLD',qrCode:'data:image/png;base64,iVBORw0KGgo=',
    expiresAt:new Date(Date.now()+600000).toISOString()};
  const f=fixture({initialStorage:{'pix-payment':JSON.stringify(payment),'pix-attempt-pending':'true'}});
  assert.equal(f.element('checkout-form').hidden,true);
  assert.equal(f.element('payment').hidden,false);
  f.clickNew();
  assert.equal(f.element('checkout-form').hidden,false);
  assert.equal(f.element('purchase-fields').disabled,false);
  assert.equal(f.saved.has('pix-payment'),false);
});

test('two rapid clicks cannot send two simultaneous Pix creation requests',async()=>{
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const f=fixture({createPayment:async()=>{await waiting;return {
    transactionId:'TXN-1',amount:39770,status:'PENDING',token:'token-1',
    copyPaste:'000201010212TEST',qrCode:'data:image/png;base64,iVBORw0KGgo=',
    expiresAt:new Date(Date.now()+600000).toISOString()
  };}});
  const first=f.submit();
  await f.submit();
  assert.equal(f.requests.length,1);
  release();
  await first;
});
