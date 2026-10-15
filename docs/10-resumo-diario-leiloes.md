# 10 - Resumo diário da agenda no WhatsApp (0.42.0)

O Picareta 0.174.0 agenda às 08h de Brasília um resumo dos leilões do dia e chama `POST /api/internal/auction-daily-summary`. Essa rota Nitro fica no layer cars e exige `x-scraper-service-key` igual a `SCRAPER_SERVICE_KEY`, com comparação em tempo constante. Aceita `{ message: string }` com até 12.000 caracteres; sem chave válida não lê o corpo nem acessa o provedor.

O envio usa a configuração Z-API existente (`ZAPI_PHONE`/`Z_PHONE`, credenciais e `ZAPI_DELAY_MESSAGE`), exclusivamente no servidor. Não aceita destino alternativo, não cria favoritos e não modifica veículos. Configuração ausente ou `ZAPI_ENABLED=false`/`0` devolve 503 antes de iniciar o envio. Após a chamada ao provedor, erros e timeouts retornam 502; aceite retorna `{ accepted: true }`. O timeout do provedor é fixo em 30 segundos.

O Picareta mantém a reserva durável por dia e o progresso entre partes, deduplica favoritos entre usuários sem expor autoria e divide mensagens grandes entre leilões. O bot não repete chamadas ao provedor. Aceite não significa confirmação de entrega; resultados incertos exigem conferir o grupo antes de reprocessar. Este contrato não altera o envio individual de veículos, o cron da busca ou o worker Windows.

Publicar o bot e o Picareta juntos, reutilizando a URL e chave do serviço já configuradas. Nenhuma nova dependência ou variável é necessária. Validação local: `pnpm exec tsx --test tests/auction-daily-summary.test.ts` e `pnpm build`, com Node compatível e as dependências nativas do ambiente do usuário. Testes usam transporte simulado e não enviam mensagens reais.

Os quatro testes da rota passaram com carregador TypeScript temporário fora do repositório, porque o esbuild local é de Windows e o ambiente do agente é Linux. O typecheck global apresentou 152 diagnósticos fora dos módulos desta implementação; nenhum na rota ou no teste novos. Build completo e envio real dependem do ambiente configurado; nenhuma dependência foi instalada ou substituída.
