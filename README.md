# Black Friday Para Sempre — checkout Pix

Landing page adaptada de `Texto colado.txt`, com a estrutura e os estilos Elementor originais, uma oferta de **R$ 397,70** e um único botão **COMPRAR VIA PIX**. Checkout Node.js responsivo, exclusivamente Pix, integrado ao contrato documentado da Black Cat.

## Rodar localmente

Requisitos: Node.js 22+ e pnpm 11.25.0.

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
pnpm start
```

Abra `http://localhost:3000`. A interface abre sem credenciais, mas a geração retorna HTTP 503 e uma mensagem de indisponibilidade. Não existe modo de pagamento falso em produção.

Configure no servidor:

| Variável | Uso |
| --- | --- |
| `APP_ORIGIN` | Origem exata do site, sem barra final, por exemplo `https://checkout.exemplo.com` |
| `BLACKCAT_API_KEY` | Chave privada da Black Cat |
| `PAYMENT_TOKEN_SECRET` | Segredo aleatório com pelo menos 32 caracteres, exclusivo deste projeto |
| `PORT` | Porta HTTP, padrão 3000 |
| `TRUST_PROXY` | `false` por padrão; habilitar somente atrás de um proxy confiável que sobrescreva X-Forwarded-For |

Gere o segredo com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Guarde as duas credenciais no gerenciador de segredos da hospedagem. Nunca use variáveis públicas, parâmetros de URL ou arquivos versionados para isso.

## Produtos e valores

| Seleção | Centavos | Total |
| --- | ---: | ---: |
| Produto principal | 39770 | R$ 397,70 |
| Principal + livro | 44770 | R$ 447,70 |
| Principal + curso | 59470 | R$ 594,70 |
| Principal + ambos | 64470 | R$ 644,70 |

O primeiro adicional foi implementado provisoriamente como o **livro físico** da captura, com frete grátis e endereço brasileiro obrigatório. Confirme o tipo do produto e a política de entrega antes de produção. O segundo é o curso de Crochetagem da captura. O catálogo do servidor (`lib/payment.js`) é a autoridade dos preços; o navegador envia apenas os identificadores dos adicionais. Campos de preço enviados pelo cliente são recusados.

## Black Cat

Documentação consultada: https://docs.blackcatoficial.com/

- Criação: `POST https://api.blackcatoficial.com/api/sales/create-sale`.
- Consulta: `GET https://api.blackcatoficial.com/api/sales/{transactionId}/status`.
- Autenticação: `X-API-Key`, exclusivamente no servidor.
- Valor em centavos, `currency: BRL`, `paymentMethod: pix`, itens e cliente validados.
- Livro: `tangible: true` e `shipping`; demais produtos digitais.
- QR gerado localmente com o `copyPaste`/`qrCode` retornado, sem serviço externo de imagens.
- Estados tratados: `PENDING`, `PAID`, `CANCELLED`, `REFUNDED`.
- Consulta exige token HMAC com ID, valor e expiração; o servidor confere ID, método e valor retornados antes de mostrar confirmação.

**Nenhuma transação real foi criada ou paga durante o desenvolvimento.** Os testes de integração usam respostas simuladas. A aceitação do payload pela conta específica, o recebedor, expiração e confirmação real precisam ser homologados com credenciais válidas. O site não envia e-mails nem libera cursos automaticamente: essa entrega depende do processo do vendedor e não foi solicitada como integração adicional.

## Sem banco de dados

Não há banco nem persistência de Pix no servidor. O navegador guarda apenas o Pix e um token de consulta no `sessionStorage` da aba, nunca os campos de identificação. No servidor, um cache volátil limitado guarda a promessa/resultado da criação e o hash do pedido por até 48 horas, para impedir duplicidade concorrente; não guarda os dados pessoais enviados ao provedor. Não há logs de payload, documentos ou credenciais.

**Limitação importante:** o cache desaparece ao reiniciar e não é compartilhado entre réplicas. A documentação consultada não estabelece garantia de idempotência para `externalRef`. Portanto, não há promessa de idempotência durável ou global. Use **uma única instância/processo** e não faça retry automático da criação. Em timeout/resposta ambígua, a interface bloqueia nova geração e orienta a consultar o suporte. Fechar a aba perde a recuperação local; confira a referência no painel da Black Cat antes de iniciar outro pagamento. A consulta com token continua funcionando após reinício se o segredo for mantido.

## Preparação de deploy

Há `Dockerfile`, lockfile e CI de testes/auditoria. Este projeto precisa de um servidor Node; **GitHub Pages não executa o backend**.

```sh
docker build -t instituto-checkout .
docker run --env-file .env -p 3000:3000 instituto-checkout
```

Use hospedagem com container/Node de longa duração, uma réplica, HTTPS e variáveis privadas. Configure `APP_ORIGIN` para o domínio final. Se houver proxy, restrinja o acesso direto ao servidor e só habilite `TRUST_PROXY` quando o proxy sobrescrever o cabeçalho. Aplique limites de tráfego também na borda: limites em memória se perdem em reinícios. Não registre corpo das requisições nem tokens no proxy/monitoramento.

O container está preparado, mas não foi construído/executado nesta máquina. Nenhum deploy público foi realizado. Antes de publicar: completar assets pendentes, confirmar livro/frete, configurar segredos e suporte ao comprador, testar uma transação autorizada e conferir a confirmação real no painel. Não há aprovação automática de compra baseada no navegador.

## Assets e fidelidade visual

- HTML e seis capturas foram recuperados da conversa de referência.
- Logo, fundo desktop/mobile, retrato do professor e capas foram recuperados dos URLs do HTML, copiados para `public/assets/original` e relacionados em `docs/asset-manifest.json`.
- Preservados estrutura visual, cores e conteúdos da landing; removidos planos antigos, comparações de preço, scripts WordPress, rastreamento, popups, pagamentos externos e contador antigo.
- Checkout usa a pilha `"Hotmart Display", "Times New Roman", Times, serif`. O arquivo licenciado da Hotmart Display não foi anexado; atualmente usa o fallback.
- As imagens anexadas são screenshots, não arquivos originais do banner superior/inferior ou da capa do livro. O banner superior foi composto em HTML com o fundo/logo recuperados; o livro tem ícone provisório. Solicitar os assets originais para fidelidade final. Não foi inventado banner inferior.
- Não há marca “protegido por Hotmart”: o processamento é Black Cat.

## Verificação

```sh
pnpm check
pnpm test
pnpm audit --prod
```

No ambiente Windows restrito, os testes também podem rodar com `node --test --test-isolation=none`.

Os testes cobrem os quatro totais, adulteração de preço, CPF/CNPJ numéricos, e-mails, celular, endereço, token adulterado/expirado, origens, limite de corpo, limite de criação, duplicação concorrente, resposta incerta, falta de credenciais, QR, estados e divergências de valor. A auditoria não apontou vulnerabilidades conhecidas na data da implementação. Isso não substitui a homologação real da conta Black Cat.
