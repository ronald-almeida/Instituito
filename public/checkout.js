const $ = id => document.getElementById(id);
const money = cents => (cents / 100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const form = $('checkout-form');
let payment = null, timer, checkingPayment = null, generating = false;
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
  errorAt('status-error','');
  renderStatus(data.status);
  if (restoring) $('payment-status').textContent = 'Verificando pagamento…';
}
function renderStatus(status) {
  clearTimeout(timer);
  const expired = Date.parse(payment.expiresAt) <= Date.now();
  const texts = {PAID:'Pagamento confirmado. Obrigado pela compra!',PENDING:expired?'O prazo do QR Code terminou. Verifique o status antes de realizar outro pagamento.':'Aguardando pagamento',CANCELLED:'Pagamento cancelado ou expirado.',REFUNDED:'Pagamento estornado.'};
  $('payment-status').textContent = texts[status] || 'Aguardando confirmação';
  $('pix-instructions').hidden = status !== 'PENDING' || expired;
  $('check-status').hidden = ['CANCELLED','REFUNDED'].includes(status);
  $('check-status').textContent = status === 'PAID' ? 'Atualizar status' : 'Já paguei · verificar pagamento';
  if (status === 'PENDING' && !expired && !document.hidden) timer = setTimeout(checkStatus,10000);
}
async function checkStatus() {
  const current = payment;
  if (!current || checkingPayment === current) return;
  checkingPayment = current; $('check-status').disabled = true;
  try {
    const result = await api('/api/pix/status',{token:current.token});
    // A previous status request must not update a newer purchase.
    if (payment !== current) return;
    current.status = result.status; storage.set('pix-payment',JSON.stringify(current));
    errorAt('status-error',''); renderStatus(result.status);
  } catch (error) {
    if (payment !== current) return;
    errorAt('status-error',error.message || 'Não foi possível consultar. Use o botão para tentar novamente.');
    clearTimeout(timer);
    if (Date.parse(current.expiresAt) <= Date.now()) $('pix-instructions').hidden = true;
  } finally {
    if (checkingPayment === current) checkingPayment = null;
    if (payment === current) $('check-status').disabled = false;
  }
}
function startNewPurchase() {
  if (generating) return;
  clearTimeout(timer);
  payment = null;
  storage.remove('pix-payment');
  storage.remove('pix-request-id');
  storage.remove('pix-attempt-pending');
  $('payment').hidden = true;

  $('check-status').disabled = false;
  $('purchase-fields').disabled = false;
  $('generate').disabled = false;
  $('generate').hidden = false;
  form.hidden = false;
  errorAt('form-error','');
  errorAt('status-error','');
  updateTotal();
  form.scrollIntoView({behavior:'smooth',block:'start'});
}
form.addEventListener('submit',async event => {
  event.preventDefault(); if (generating || payment) return;
  $('emailConfirmation').setCustomValidity('');
  if ($('email').value.trim().toLowerCase() !== $('emailConfirmation').value.trim().toLowerCase()) { $('emailConfirmation').setCustomValidity('Os e-mails não coincidem.'); $('emailConfirmation').reportValidity(); return; }
  generating = true; $('generate').disabled = true; $('generate').textContent = 'Gerando Pix…'; errorAt('form-error','');
  // Every deliberate submission is a new order; no stale request ID can lock the checkout.
  const requestId = crypto.randomUUID();
  const data = new FormData(form);
  const customer = Object.fromEntries(['name','email','emailConfirmation','document','phone'].map(k => [k,data.get(k)]));
  const payload = {requestId,customer,bumps:['book','course'].filter(k=>$(k).checked)};
  if ($('book').checked) payload.shipping = Object.fromEntries(['name','zipCode','state','street','number','complement','neighborhood','city'].map(k=>[k,data.get(`shipping-${k}`)]));
  // Lock the form while creating so its visible total cannot diverge from the charge.
  $('purchase-fields').disabled = true;
  try {
    const result = await api('/api/pix',payload);
    storage.set('pix-payment',JSON.stringify(result));
    showPayment(result); $('payment').focus(); checkStatus();
  } catch(error) {
    const uncertain = !error.code || ['PAYMENT_UNCERTAIN','SERVER_ERROR'].includes(error.code);
    const notice = 'Você pode tentar novamente. Se a tentativa anterior tiver criado um Pix, ela poderá continuar válida; confira com o suporte antes de pagar para evitar dois pagamentos. Referência: ' + requestId;
    errorAt('form-error',uncertain?'Não foi possível confirmar a geração do Pix. ' + notice:error.message);
    // Failures must never permanently disable the form or create a persistent lock.
    $('purchase-fields').disabled = false;
    updateTotal();
    $('form-error').focus();
  } finally { generating = false; $('generate').disabled = false; $('generate').textContent = 'Gerar Pix'; }
});
$('emailConfirmation').addEventListener('input',()=>$('emailConfirmation').setCustomValidity(''));
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(payment.copyPaste);$('copy').textContent='Código copiado';}catch{$('copy-paste').focus();$('copy-paste').select();$('copy').textContent='Selecione e copie o código acima';}});
$('check-status').addEventListener('click',checkStatus);
$('new-purchase').addEventListener('click',startNewPurchase);
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden && payment)checkStatus();});
updateTotal();
// Clear locks left by earlier checkout versions.
storage.remove('pix-attempt-pending');
storage.remove('pix-request-id');
try {
  const saved = JSON.parse(storage.get('pix-payment') || 'null');
  if (saved && typeof saved.token === 'string' && Number.isInteger(saved.amount) && Number.isFinite(Date.parse(saved.expiresAt))) {
    showPayment(saved,true);
    checkStatus();
  } else {
    storage.remove('pix-payment');
  }
} catch {
  storage.remove('pix-payment');
  errorAt('form-error','Não foi possível recuperar o Pix anterior. Você pode iniciar uma nova compra.');
}
