import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export class PublicError extends Error {
  constructor(status, message, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; }
}
export const catalog = Object.freeze({
  main: { title: 'Black Friday Para Sempre', unitPrice: 39770, tangible: false },
  book: { title: 'Livro Físico — Crochetagem: A Técnica do Gancho', unitPrice: 5000, tangible: true },
  course: { title: 'Liberação Miofascial Crochetagem — A Técnica do Gancho', unitPrice: 19700, tangible: false },
});
const invalid = message => { throw new PublicError(400, message); };
function string(value, label, min = 1, max = 200) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\x00-\x1f]/.test(value)) invalid(`${label} inválido.`);
  return value.trim();
}
function digits(value, label) {
  const input = string(value, label, 1, 30);
  if (!/^[\d .()+/-]+$/.test(input)) invalid(`${label} inválido.`);
  return input.replace(/\D/g, '');
}
export function validDocument(n) {
  if (!/^\d{11}$|^\d{14}$/.test(n) || /^(\d)\1+$/.test(n)) return false;
  const digit = (s, weights) => { const r = [...s].reduce((sum, c, i) => sum + Number(c) * weights[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  if (n.length === 11) return digit(n.slice(0,9),[10,9,8,7,6,5,4,3,2]) === +n[9] && digit(n.slice(0,10),[11,10,9,8,7,6,5,4,3,2]) === +n[10];
  return digit(n.slice(0,12),[5,4,3,2,9,8,7,6,5,4,3,2]) === +n[12] && digit(n.slice(0,13),[6,5,4,3,2,9,8,7,6,5,4,3,2]) === +n[13];
}
export function buildSale(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Pedido inválido.');
  if (Object.keys(input).some(k => !['customer','bumps','shipping','requestId'].includes(k))) invalid('O pedido contém campos não permitidos.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId ?? '')) invalid('Identificador do pedido inválido.');
  if (!Array.isArray(input.bumps) || input.bumps.some(b => !['book','course'].includes(b)) || new Set(input.bumps).size !== input.bumps.length) invalid('Adicionais inválidos.');
  const c = input.customer;
  if (!c || typeof c !== 'object') invalid('Preencha seus dados.');
  const name = string(c.name, 'Nome', 3, 150);
  const email = string(c.email, 'E-mail', 5, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('E-mail inválido.');
  if (email !== string(c.emailConfirmation, 'Confirmação de e-mail', 5, 254).toLowerCase()) invalid('Os e-mails não coincidem.');
  const number = digits(c.document, 'CPF/CNPJ');
  if (!validDocument(number)) invalid('CPF/CNPJ inválido.');
  let phone = digits(c.phone, 'Celular');
  if (phone.startsWith('55') && phone.length === 13) phone = phone.slice(2);
  if (!/^[1-9]{2}9\d{8}$/.test(phone)) invalid('Informe celular com DDD e 9 dígitos.');
  const items = ['main', ...[...input.bumps].sort()].map(id => ({ ...catalog[id], quantity: 1 }));
  const sale = { amount: items.reduce((s, i) => s + i.unitPrice, 0), currency: 'BRL', paymentMethod: 'pix', items, customer: {name,email,phone,document:{number,type:number.length === 11 ? 'cpf':'cnpj'}}, pix:{expiresInDays:1}, externalRef:input.requestId };
  if (input.bumps.includes('book')) {
    const s = input.shipping;
    if (!s || typeof s !== 'object') invalid('Informe o endereço para receber o livro.');
    const shipping = Object.fromEntries(['name','street','number','neighborhood','city','state'].map(k => [k,string(s[k], `Endereço (${k})`,1,150)]));
    shipping.state = shipping.state.toUpperCase();
    if (!'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ').includes(shipping.state)) invalid('UF inválida.');
    shipping.zipCode = digits(s.zipCode, 'CEP');
    if (shipping.zipCode.length !== 8) invalid('CEP inválido.');
    if (s.complement) shipping.complement = string(s.complement,'Complemento',1,150);
    sale.shipping = shipping;
  }
  return sale;
}
export function fingerprint(sale) { return createHash('sha256').update(JSON.stringify(sale)).digest('hex'); }
export function signPayment(data, secret) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;
}
export function verifyPayment(token, secret, now = Date.now()) {
  const fail = () => { throw new PublicError(401,'Consulta expirada ou inválida.','INVALID_TOKEN'); };
  if (typeof token !== 'string' || token.length > 2000) return fail();
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra) return fail();
  const expected = createHmac('sha256',secret).update(payload).digest();
  const actual = Buffer.from(sig,'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) return fail();
  let data; try { data = JSON.parse(Buffer.from(payload,'base64url').toString()); } catch { return fail(); }
  if (!Number.isFinite(data.exp) || data.exp <= now || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id) || !Number.isInteger(data.amount)) return fail();
  return data;
}
export async function blackcat(path, config, body) {
  const operation = body ? 'create' : 'status';
  // Log only the provider HTTP status and a non-sensitive event code.
  // Never log the API key, request body, provider response or customer data.
  const diagnostic = (event, status) => console.warn('BLACKCAT_DIAGNOSTIC', {
    operation, event, status: Number.isInteger(status) ? status : null
  });
  let response;
  try {
    response = await config.fetch(`https://api.blackcatoficial.com/api${path}`, {
      method:body ? 'POST' : 'GET',
      headers:{'X-API-Key':config.apiKey,'Content-Type':'application/json'},
      ...(body ? {body:JSON.stringify(body)} : {}),
      signal:AbortSignal.timeout(20000),
      redirect:'error'
    });
  } catch (error) {
    const timedOut = ['TimeoutError','AbortError'].includes(error?.name) ||
      ['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code);
    diagnostic(timedOut ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR');
    throw new PublicError(502,timedOut
      ? 'A conexão com a Black Cat expirou antes de confirmar o Pix.'
      : 'Não foi possível completar a conexão com a Black Cat.',
      timedOut ? 'GATEWAY_TIMEOUT' : 'GATEWAY_NETWORK');
  }

  // Read the provider response even for HTTP errors; never expose it verbatim.
  let result;
  try { result = await response.json(); }
  catch {
    diagnostic('NON_JSON_RESPONSE',response.status);
    throw new PublicError(502,'A Black Cat retornou uma resposta inválida.','PAYMENT_UNCERTAIN');
  }

  if (!response.ok) {
    if (response.status === 401) {
      diagnostic('INVALID_API_KEY',401);
      throw new PublicError(503,'A Black Cat recusou a chave da API. Verifique BLACKCAT_API_KEY na Vercel.','GATEWAY_AUTH');
    }
    if (response.status === 403) {
      diagnostic('ACCOUNT_NOT_AUTHORIZED',403);
      throw new PublicError(503,'A conta Black Cat não está autorizada a processar esta operação. Verifique a liberação da API no painel.','GATEWAY_FORBIDDEN');
    }
    if ([400,422].includes(response.status)) {
      diagnostic('INVALID_REQUEST_BODY',response.status);
      throw new PublicError(502,'A Black Cat rejeitou os dados enviados para gerar o Pix (HTTP '+response.status+').','GATEWAY_VALIDATION');
    }
    if (response.status === 429) {
      diagnostic('RATE_LIMIT',429);
      throw new PublicError(503,'A Black Cat limitou novas operações. Aguarde alguns minutos.','GATEWAY_RATE_LIMIT');
    }
    diagnostic('PROVIDER_HTTP_ERROR',response.status);
    throw new PublicError(502,'A Black Cat não confirmou o Pix (HTTP '+response.status+').','PAYMENT_UNCERTAIN');
  }
  if (result?.success !== true || !result.data || typeof result.data !== 'object') {
    diagnostic('PROVIDER_REJECTED_RESPONSE',response.status);
    throw new PublicError(502,'A Black Cat não confirmou a operação, mesmo após responder.','PAYMENT_UNCERTAIN');
  }
  return result.data;
}
