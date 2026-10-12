import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import QRCode from 'qrcode';
import { PublicError, buildSale, fingerprint, signPayment, verifyPayment, blackcat } from './lib/payment.js';

const publicDir = fileURLToPath(new URL('./public/',import.meta.url));
export function createHandler(options = {}) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const config = {origin:process.env.APP_ORIGIN || (host ? `https://${host}` : 'http://localhost:3000'),apiKey:process.env.BLACKCAT_API_KEY,secret:process.env.PAYMENT_TOKEN_SECRET,fetch:globalThis.fetch,trustProxy:process.env.TRUST_PROXY === 'true',...options};
  const orders = new Map(), limits = new Map();
  function prune() {
    const now = Date.now();
    for (const [k,v] of orders) if (v.expires < now) orders.delete(k);
    for (const [k,v] of limits) if (v.expires < now) limits.delete(k);
  }
  function rate(req, kind) {
    const address = config.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
    const key = `${kind}:${address}`;
    let bucket = limits.get(key);
    if (!bucket || bucket.expires < Date.now()) { bucket = {count:0,expires:Date.now()+(kind === 'create'?600000:60000)}; limits.set(key,bucket); }
    if (++bucket.count > (kind === 'create'?5:90)) throw new PublicError(429,'Muitas tentativas. Aguarde alguns minutos.','RATE_LIMIT');
    if (limits.size > 20000) throw new PublicError(503,'Serviço temporariamente ocupado.');
  }
  function configured() {
    if (!config.apiKey || !config.secret || config.secret.length < 32) throw new PublicError(503,'Pagamento temporariamente indisponível. Tente mais tarde.','NOT_CONFIGURED');
  }
  async function body(req) {
    if (req.headers.origin !== config.origin || (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site']))) throw new PublicError(403,'Origem da solicitação inválida.');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new PublicError(415,'Formato inválido.');
    // Vercel may parse JSON before invoking the Node handler.
    if (req.body !== undefined) {
      const serialized = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (Buffer.byteLength(serialized) > 12000) throw new PublicError(413,'Solicitação muito grande.');
      try { return JSON.parse(serialized); } catch { throw new PublicError(400,'Solicitação inválida.'); }
    }
    let input = '', size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 12000) throw new PublicError(413,'Solicitação muito grande.'); input += chunk; }
    try { return JSON.parse(input); } catch { throw new PublicError(400,'Solicitação inválida.'); }
  }
  async function generate(sale) {
    const data = await blackcat('/sales/create-sale',config,sale);
    const code = data.paymentData?.copyPaste || data.paymentData?.qrCode;
    const expires = Date.parse(data.paymentData?.expiresAt);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(data.transactionId || '') || data.amount !== sale.amount || !['PENDING','PAID'].includes(data.status) || String(data.paymentMethod).toLowerCase() !== 'pix' || typeof code !== 'string' || code.length > 4000 || !code.startsWith('000201') || !Number.isFinite(expires) || expires <= Date.now()) throw new PublicError(502,'O serviço retornou dados incompletos. Consulte o suporte antes de tentar novamente.','PAYMENT_UNCERTAIN');
    const token = signPayment({id:data.transactionId,amount:sale.amount,exp:expires+86400000},config.secret);
    return {transactionId:data.transactionId,amount:sale.amount,status:data.status,copyPaste:code,qrCode:await QRCode.toDataURL(code,{errorCorrectionLevel:'M',width:320,margin:4}),expiresAt:new Date(expires).toISOString(),token};
  }
  const handler = async (req,res) => {
    const send = (status,data) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (config.origin.startsWith('https://')) res.setHeader('Strict-Transport-Security','max-age=31536000');
    try {
      const url = new URL(req.url,'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control','no-store');
        if (req.method !== 'POST') { res.setHeader('Allow','POST'); throw new PublicError(405,'Método não permitido.'); }
        if (!['/api/pix','/api/pix/status'].includes(url.pathname)) throw new PublicError(404,'Não encontrado.');
        prune();
        const input = await body(req);
        configured();
        if (url.pathname === '/api/pix') {
          const sale = buildSale(input), hash = fingerprint(sale);
          const existing = orders.get(input.requestId);
          rate(req,existing ? 'status' : 'create');
          if (existing) {
            if (existing.hash !== hash) throw new PublicError(409,'Este pedido já foi iniciado com outros dados.','ORDER_CONFLICT');
            return send(200,await existing.promise);
          }
          if (orders.size >= 5000) throw new PublicError(503,'Serviço temporariamente ocupado.');
          // Insert the promise before awaiting: concurrent duplicate requests share one charge.
          // Keep rejected promises too: never retry a potentially created charge automatically.
          const promise = generate(sale);
          orders.set(input.requestId,{hash,promise,expires:Date.now()+172800000});
          return send(201,await promise);
        }
        rate(req,'status');
        const claim = verifyPayment(input.token,config.secret);
        const data = await blackcat(`/sales/${encodeURIComponent(claim.id)}/status`,config);
        if (data.transactionId !== claim.id || data.amount !== claim.amount || String(data.paymentMethod).toLowerCase() !== 'pix' || !['PENDING','PAID','CANCELLED','REFUNDED'].includes(data.status)) throw new PublicError(502,'Não foi possível validar o status do pagamento.');
        return send(200,{status:data.status,amount:data.amount});
      }
      if (!['GET','HEAD'].includes(req.method)) throw new PublicError(405,'Método não permitido.');
      let filename = url.pathname === '/' ? 'index.html' : url.pathname === '/checkout' ? 'checkout.html' : decodeURIComponent(url.pathname).replace(/^\//,'');
      const absolute = path.resolve(publicDir,filename);
      if (!absolute.startsWith(publicDir) || filename.split(/[\\/]/).some(p=>p.startsWith('.'))) throw new PublicError(404,'Não encontrado.');
      const ext = path.extname(absolute);
      const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
      if (!types[ext]) throw new PublicError(404,'Não encontrado.');
      const content = await readFile(absolute);
      res.setHeader('Cache-Control',['.html','.css','.js'].includes(ext)?'no-cache':'public, max-age=3600');
      res.writeHead(200,{'Content-Type':types[ext]}); res.end(req.method === 'HEAD'?undefined:content);
    } catch (error) {
      const status = error instanceof PublicError ? error.status : error.code === 'ENOENT' ? 404 : 500;
      if (status === 429) res.setHeader('Retry-After','600');
      send(status,{error:error instanceof PublicError?error.message:status===404?'Não encontrado.':'Não foi possível processar a solicitação.',code:error instanceof PublicError?error.code:'SERVER_ERROR'});
    }
  };
  return handler;
}
export function createApp(options = {}) {
  return http.createServer({requestTimeout:30000,headersTimeout:10000},createHandler(options));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port,'0.0.0.0',()=>console.log(`Checkout disponível na porta ${port}.`));
}
