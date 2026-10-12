# Deploy na Vercel

Projeto `instituito`, conectado a `ronald-almeida/Instituito`, branch `main`.

`public/` é servido como conteúdo estático. `/checkout` aponta para `checkout.html`. As funções Node `api/pix.js` e `api/pix/status.js` reutilizam o backend validado. O servidor local e o Docker continuam disponíveis.

Em Settings → Environment Variables, configure `BLACKCAT_API_KEY` e `PAYMENT_TOKEN_SECRET` (segredo aleatório de pelo menos 32 caracteres) no ambiente Production e faça novo deploy. `APP_ORIGIN` pode definir o domínio final exato; quando omitido, é usado `VERCEL_PROJECT_PRODUCTION_URL`. Não coloque chaves em variáveis públicas nem envie pelo chat.

Sem credenciais, a interface permanece disponível, mas geração e consulta retornam 503. Não houve transação real Black Cat na publicação inicial.

## Limitação sem banco de dados

Vercel pode executar várias instâncias e descartar processos. Os caches de repetição e de limite de frequência são apenas locais à instância, não são garantias globais. Não há armazenamento de Pix em banco. O navegador bloqueia a repetição após resposta incerta, mas a API Black Cat precisa ter sua idempotência validada com o provedor antes de ativar cobranças em produção. `externalRef` não é tratado como garantia de idempotência. Configure limites de tráfego na Vercel antes de ativar pagamentos públicos. Tokens assinados permitem consulta entre instâncias desde que compartilhem `PAYMENT_TOKEN_SECRET`.
