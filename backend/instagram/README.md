# Instagram Bot (V1)

Servicio separado para Instagram, aislado del webhook de WhatsApp.

## Start local

```bash
npm run start:instagram
```

## Variables de entorno

- `DATABASE_URL` (requerida)
- `IG_VERIFY_TOKEN` (requerida para `GET /instagram/webhook`)
- `IG_PAGE_ACCESS_TOKEN` (requerida para responder por Graph API)
- `IG_APP_SECRET` (requerida para validar `X-Hub-Signature-256`)
- `IG_DEFAULT_COMPANY_ID` (opcional, default `babystepsbots`)
- `IG_GRAPH_VERSION` (opcional, default `v22.0`)
- `IG_BUSINESS_ID` (opcional; fallback si no llega `recipient.id`)

## Endpoints

- `GET /instagram/webhook`
- `POST /instagram/webhook`
- `GET /health`

## Tablas nuevas (Postgres)

- `ig_sessions`
- `ig_messages`

No usa ni modifica tablas del flujo WhatsApp (`sessions`, `orders`, `ai_messages`, etc.).
