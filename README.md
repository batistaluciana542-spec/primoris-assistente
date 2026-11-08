# PRIMORIS — Assistente Pessoal do Cesar v1.1

Esta versão acrescenta um backend opcional para integrações reais.

## Local

1. Instale Node.js 20+.
2. Copie `.env.example` para `.env`.
3. Preencha as credenciais necessárias.
4. Execute `npm install`.
5. Execute `npm start`.
6. Abra `http://localhost:3000`.

## Google Calendar

Ative a Google Calendar API no Google Cloud e crie um cliente OAuth 2.0 do tipo Web application. Use exatamente a URL de callback configurada no `.env`.

O servidor guarda o refresh token em `.data/google-token.json`, que está no `.gitignore`. Em produção, use armazenamento secreto/criptografado e HTTPS.

A aplicação consegue:
- iniciar OAuth;
- sincronizar os próximos eventos do calendário principal;
- criar eventos pelo endpoint do servidor;
- excluir eventos pelo endpoint do servidor.

## Inteligência artificial

A chave OpenAI fica somente no servidor. O navegador chama `/api/ai`.

A integração usa a Responses API, recomendada para novas integrações, e não a antiga Assistants API.

## Notícias

A aba de notícias consulta buscas RSS do Google Notícias no servidor e mostra título, fonte, publicação, consulta e link. O Google Notícias continua sendo aberto pelo link oficial. Não existe uma simples API pública para embutir o feed pessoal do Google Notícias como se fosse uma API comum, então a implementação não inventa uma integração inexistente.

## Limitações

- O calendário externo só fica realmente conectado depois que você configurar OAuth no Google Cloud e autorizar a conta.
- A IA só fica ativa depois que `OPENAI_API_KEY` estiver configurada no servidor.
- Push com site fechado exige infraestrutura de notificações.
- A versão local continua funcionando sem backend usando armazenamento local.
