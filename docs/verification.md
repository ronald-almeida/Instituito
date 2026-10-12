# Verificação — 12/10/2026

## Executado

- 11 testes de backend passaram em Node.js: preço em centavos nas quatro combinações, adulteração, dados do comprador/endereço, assinatura/expiração, concorrência, resposta ambígua, ausência de credenciais, validação da origem, tamanho e frequência de solicitações, QR e estados de pagamento.
- `node --check` passou para servidor e script do checkout.
- `pnpm audit --prod`: nenhuma vulnerabilidade conhecida reportada.
- GitHub Actions executou instalação com lockfile, sintaxe, testes e auditoria com sucesso na implementação inicial.
- Browser desktop e mobile (390 px): navegação landing → checkout, único CTA, imagens recuperadas, seleção dos dois adicionais com total R$644,70 e abertura condicional do endereço.
- Landing mobile sem transbordamento horizontal; um único preço visível R$397,70 e um único link de compra.
- Sem credenciais: geração bloqueada com mensagem de indisponibilidade, sem cobrança simulada apresentada como real.
- Servidor isolado de QA, fora do repositório, com resposta Black Cat simulada: geração do QR, copia-e-cola conferido, consulta PENDING → PAID e ocultação das instruções após confirmação.

## Não executado / pendente

- Transação real Black Cat, pagamento, confirmação na conta e entrega de acesso.
- Build/execução do Dockerfile e deploy público.
- Assets de checkout recebidos em atualização posterior: ambos os banners, logo e duas capas aplicados. Verificados no navegador em desktop e 390 px, sem transbordamento horizontal. Ícone Pix e selo SVG conferidos; link de retorno e parágrafo indicados removidos.
- Arquivo licenciado Hotmart Display ausente; fonte alternativa aplicada no checkout.
- Confirmação do adicional físico e frete; implementação provisória segue a captura.

## Limites conhecidos

Sem banco de dados: proteção contra criação repetida é limitada a uma instância e ao ciclo de vida do processo. A API documenta `externalRef`, mas não foi presumida idempotência durável nesse campo. A interface bloqueia retries após resposta ambígua. O token de status continua válido após reinício enquanto o segredo permanecer o mesmo. A recuperação do QR é limitada à aba do navegador.
