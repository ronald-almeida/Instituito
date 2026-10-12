const $ = id => document.getElementById(id);
const money = cents => (cents / 100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const form = $('checkout-form');
let payment = null, timer, checking = false, generating = false;
const storage = {get(k){try{return sessionStorage.getItem(k);}catch{return null;}},set(k,v){try{sessionStorage.setItem(k,v);}catch{}},remove(k){try{sessionStorage.removeItem(k);}catch{}}};
function updateTotal() {
  $('total').textContent = money(39770 + ($('book').checked ? 5000 : 0) + ($('course').checked ? 19700 : 0));
  $('book-row').hidden = !$('book').checked; $('course-row').hidden = !$('course').checked;
  $('shipping-fields').hidden = !$('book').checked; $('shipping-fields').disabled = !$('book').checked;
}
['book','course'].forEach(id => $(id).addEventListener('change',updateTotal));
async function api(url, data) {
  const response = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(30000),cache:'no-store'});
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'Não foi possível concluir.'); error.code = result.code; throw error; }
  return result;
}
function errorAt(id, text) { $(id).textContent = text; $(id).hidden = !text; }
function showPayment(data, restoring = false) {
  payment = data; clearTimeout(timer);
  form.hidden = true;
  $('purchase-fields').disabled = true; $('generate').hidden = true;
  $('payment').hidden = false; $('payment-amount').textContent = money(data.amount);
  if (typeof data.qrCode === 'string' && data.qrCode.startsWith('data:image/png;base64,')) $('qr-code').src = data.qrCode;
  $('copy-paste').value = data.copyPaste;
  $('expires').textContent = `Válido até ${new Date(data.expiresAt).toLocaleString('pt-BR')}`;
  $('order-ref').textContent = `Referência: ${data.transactionId}`;
  if (restoring) {
    $('payment-status').textContent = 'Verificando pagamento…';
    $('pix-instructions').hidden = true;
  } else renderStatus(data.status);
}
function renderStatus(status) {
  clearTimeout(timer);
  const expired = Date.parse(payment.expiresAt) <= Date.now();
  const texts = {PAID:'Pagamento confirmado. Obrigado pela compra!',PENDING:expired?'O prazo do QR Code terminou. Verifique o status antes de realizar outro pagamento.':'Aguardando pagamento',CANCELLED:'Pagamento cancelado ou expirado.',REFUNDED:'Pagamento estornado.'};
  $('payment-status').textContent = texts[status] || 'Aguardando confirmação';
  $('pix-instructions').hidden = status !== 'PENDING' || expired;
  $('check-status').hidden = ['CANCELLED','REFUNDED'].includes(status);
  if (status === 'PENDING' && !expired && !document.hidden) timer = setTimeout(checkStatus,10000);
}
async function checkStatus() {
  if (!payment || checking) return;
  checking = true; $('check-status').disabled = true;
  try {
    const result = await api('/api/pix/status',{token:payment.token});
    payment.status = result.status; storage.set('pix-payment',JSON.stringify(payment));
    errorAt('status-error',''); renderStatus(result.status);
  } catch (error) {
    errorAt('status-error',error.message || 'Não foi possível consultar. Use o botão para tentar novamente.');
    clearTimeout(timer);
    // A failed consultation never means the payment failed. Preserve the QR and reference.
    if (Date.parse(payment.expiresAt) <= Date.now()) $('pix-instructions').hidden = true;
  } finally { checking = false; $('check-status').disabled = false; }
}
form.addEventListener('submit',async event => {
  event.preventDefault(); if (generating || payment) return;
  $('emailConfirmation').setCustomValidity('');
  if ($('email').value.trim().toLowerCase() !== $('emailConfirmation').value.trim().toLowerCase()) { $('emailConfirmation').setCustomValidity('Os e-mails não coincidem.'); $('emailConfirmation').reportValidity(); return; }
  generating = true; $('generate').disabled = true; $('generate').textContent = 'Gerando Pix…'; errorAt('form-error','');
  const requestId = storage.get('pix-request-id') || crypto.randomUUID();
  storage.set('pix-request-id',requestId);
  const data = new FormData(form);
  const customer = Object.fromEntries(['name','email','emailConfirmation','document','phone'].map(k => [k,data.get(k)]));
  const payload = {requestId,customer,bumps:['book','course'].filter(k=>$(k).checked)};
  if ($('book').checked) payload.shipping = Object.fromEntries(['name','zipCode','state','street','number','complement','neighborhood','city'].map(k=>[k,data.get(`shipping-${k}`)]));
  // Lock the form while creating so its visible total cannot diverge from the charge.
  $('purchase-fields').disabled = true;
  try {
    storage.set('pix-attempt-pending','true');
    const result = await api('/api/pix',payload);
    storage.remove('pix-attempt-pending');
    storage.set('pix-payment',JSON.stringify(result));
    showPayment(result); $('payment').focus(); checkStatus();
  } catch(error) {
    const uncertain = !error.code || ['PAYMENT_UNCERTAIN','ORDER_CONFLICT','SERVER_ERROR'].includes(error.code);
    errorAt('form-error',uncertain?'Não foi possível confirmar a geração. Para evitar pagamento duplicado, não gere outro Pix. Consulte o suporte e informe a referência: '+requestId:error.message);
    if (!uncertain) { storage.remove('pix-attempt-pending'); $('purchase-fields').disabled = false; updateTotal(); }
    $('form-error').focus();
  } finally { generating = false; $('generate').disabled = false; $('generate').textContent = 'Gerar Pix'; }
});
$('emailConfirmation').addEventListener('input',()=>$('emailConfirmation').setCustomValidity(''));
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(payment.copyPaste);$('copy').textContent='Código copiado';}catch{$('copy-paste').focus();$('copy-paste').select();$('copy').textContent='Selecione e copie o código acima';}});
$('check-status').addEventListener('click',checkStatus);
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden && payment)checkStatus();});
updateTotal();
try {
  const saved = JSON.parse(storage.get('pix-payment') || 'null');
  if (saved && typeof saved.token === 'string' && Number.isInteger(saved.amount) && Number.isFinite(Date.parse(saved.expiresAt))) { showPayment(saved,true); checkStatus(); }
  else if (storage.get('pix-attempt-pending')) { $('purchase-fields').disabled = true; errorAt('form-error','Uma tentativa de pagamento está sem confirmação. Consulte o suporte antes de gerar outro Pix. Referência: '+storage.get('pix-request-id')); }
} catch { errorAt('form-error','Não foi possível recuperar o pagamento nesta aba. Consulte o suporte antes de gerar outro Pix.'); $('purchase-fields').disabled = true; }
